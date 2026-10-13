require "digest"
require "fileutils"
require "json"
require "open3"
require "time"

SUBJECT_SHA = "1e47d150f6caddffc8e006fd4bec9d89bed5732a"
SUBJECT_TREE = "beb6464d69b2b972237ccd20b20e827f2eb81005"
LOG_LIMIT = 8 * 1024 * 1024
EVIDENCE_LIMIT = 64 * 1024 * 1024
STAGE_TIMEOUTS = { "install" => 120, "build" => 90, "test" => 240 }.freeze
TOTAL_TIMEOUT_SECONDS = 480

subject = File.realpath(ARGV.fetch(0))
evidence = File.expand_path(ARGV.fetch(1))
FileUtils.mkdir_p(evidence)
helper_root = File.dirname(__FILE__)

def capture!(*command)
    output, status = Open3.capture2e(*command)
    raise "Read-only prerequisite failed: #{command.first}" unless status.success?
    output.strip
end

def identity!(subject, evidence, label)
    head = capture!("git", "-C", subject, "rev-parse", "HEAD")
    tree = capture!("git", "-C", subject, "rev-parse", "HEAD^{tree}")
    status = capture!("git", "-C", subject, "status", "--porcelain", "--untracked-files=no")
    raise "Subject identity changed" unless head == SUBJECT_SHA && tree == SUBJECT_TREE && status.empty?
    File.write(File.join(evidence, "identity-#{label}.json"), JSON.pretty_generate({ head: head, tree: tree, tracked_status: status }) + "\n")
end

def stop_group(pid)
    Process.kill("TERM", -pid)
    sleep 2
    Process.kill("KILL", -pid)
rescue Errno::ESRCH
    nil
end

def run_command(subject, evidence, label, command, extra_env = {}, deadline: nil)
    log_path = File.join(evidence, "#{label}.log")
    metadata = { command: command, start: Time.now.utc.iso8601 }
    stage_deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + STAGE_TIMEOUTS.fetch(label)
    reader, writer = IO.pipe
    pid = Process.spawn(extra_env, *command, chdir: subject, out: writer, err: writer, pgroup: true)
    writer.close
    overflow = false
    copier = Thread.new do
        written = 0
        File.open(log_path, "wb") do |log|
            loop do
                chunk = reader.readpartial(16 * 1024)
                room = LOG_LIMIT - written
                log.write(chunk.byteslice(0, room)) if room.positive?
                written += chunk.bytesize
                overflow = true if written > LOG_LIMIT
            end
        end
    rescue EOFError
        reader.close
    end
    status = nil
    reason = nil
    loop do
        completed = Process.waitpid2(pid, Process::WNOHANG)
        if completed
            status = completed.last
            break
        end
        mem = File.read("/proc/meminfo")
        available_kb = mem[/^MemAvailable:\s+(\d+)/, 1].to_i
        pressure = File.exist?("/proc/pressure/memory") ? File.read("/proc/pressure/memory") : "unavailable"
        full_avg10 = pressure[/^full avg10=([\d.]+)/, 1].to_f
        stats = capture!("ps", "-eo", "pid,ppid,pgid,pcpu,rss,comm", "--no-headers").lines.select { |line| line.split[2] == pid.to_s }
        File.open(File.join(evidence, "resources.jsonl"), "a") do |log|
            log.puts JSON.generate({ time: Time.now.utc.iso8601, stage: label, available_kb: available_kb, memory_pressure: pressure, processes: stats.map(&:strip) })
        end
        bytes = Dir[File.join(evidence, "**", "*")].select { |path| File.file?(path) }.sum { |path| File.size(path) }
        now = Process.clock_gettime(Process::CLOCK_MONOTONIC)
        reason = "total diagnostic deadline exceeded" if deadline && now >= deadline
        reason ||= "#{label} stage deadline exceeded" if now >= stage_deadline
        reason = "memory pressure" if available_kb < 512 * 1024 || full_avg10 >= 5.0
        reason ||= "bounded output limit" if overflow || bytes > EVIDENCE_LIMIT
        if reason
            stop_group(pid)
            status = Process.waitpid2(pid).last
            break
        end
        next_deadline = [stage_deadline, deadline].compact.min
        sleep [[next_deadline - Process.clock_gettime(Process::CLOCK_MONOTONIC), 0].max, 5].min
    end
    copier.join(5)
    if copier.alive?
        reason ||= "output pipe remained open after process exit"
        stop_group(pid)
        reader.close unless reader.closed?
        copier.kill
    end
    reason ||= "bounded output limit" if overflow
    metadata.merge!(finish: Time.now.utc.iso8601, exit_code: status.exitstatus, signal: status.termsig, stopped: reason)
    File.write(File.join(evidence, "#{label}-exit.json"), JSON.pretty_generate(metadata) + "\n")
    raise "#{label} blocked: #{reason}" if reason
    raise "#{label} failed: exit #{status.exitstatus}, signal #{status.termsig}" unless status.success?
rescue StandardError
    stop_group(pid) if pid
    begin
        Process.waitpid(pid) if pid
    rescue Errno::ECHILD
        nil
    end
    writer.close if writer && !writer.closed?
    reader.close if reader && !reader.closed?
    copier.kill if copier && copier.alive?
    raise
end

exit_code = 0
dependency = File.join(subject, "node_modules/vitest/dist/chunks/index.B521nVV-.js")
backup = File.join(evidence, "rpc", "birpc.original.js")
begin
    total_deadline = Process.clock_gettime(Process::CLOCK_MONOTONIC) + TOTAL_TIMEOUT_SECONDS
    identity!(subject, evidence, "before")
    control_sha = capture!("git", "-C", helper_root, "rev-parse", "HEAD")
    helpers = ["probe.rb", "instrument.rb", "summarize.rb"].to_h { |name| [name, Digest::SHA256.file(File.join(helper_root, name)).hexdigest] }
    File.write(File.join(evidence, "diagnostic-control.json"), JSON.pretty_generate({ control_sha: control_sha, helper_sha256: helpers }) + "\n")
    runtime = JSON.parse(capture!("node", "-p", "JSON.stringify({version:process.version,execPath:process.execPath,platform:process.platform,arch:process.arch})"))
    raise "Wrong runtime" unless runtime["version"] == "v22.23.3" && runtime["platform"] == "linux"
    File.write(File.join(evidence, "runtime.json"), JSON.pretty_generate(runtime) + "\n")
    run_command(subject, evidence, "install", ["pnpm", "install", "--frozen-lockfile"], deadline: total_deadline)
    run_command(subject, evidence, "build", ["pnpm", "build"], deadline: total_deadline)
    identity!(subject, evidence, "after-build")
    sources = Dir[File.join(subject, "src", "**", "*.ts")] + ["package.json", "tsconfig.json", "tsdown.config.ts"].map { |p| File.join(subject, p) }
    latest = sources.select { |p| File.file?(p) }.max_by { |p| File.mtime(p) }
    artifacts = ["dist/cli.js", "dist/aimock-cli.js"].map do |relative|
        path = File.join(subject, relative)
        raise "Stale build: #{relative}" unless File.mtime(path) > File.mtime(latest)
        { path: relative, mtime: File.mtime(path).to_f, sha256: Digest::SHA256.file(path).hexdigest }
    end
    File.write(File.join(evidence, "build-inputs.json"), JSON.pretty_generate({ latest_input: latest.delete_prefix(subject + "/"), latest_mtime: File.mtime(latest).to_f, artifacts: artifacts }) + "\n")
    FileUtils.mkdir_p(File.dirname(backup))
    raise "Unexpected dependency version" unless Digest::SHA256.file(dependency).hexdigest == "207b5394beb3d4599bae86b4921a28b3a7a9cb6c3266286ea822bd8d1cb39830"
    capture!("ruby", File.join(helper_root, "instrument.rb"), subject, File.dirname(backup))
    FileUtils.cp(dependency, File.join(File.dirname(backup), "birpc.instrumented.js"))
    run_command(subject, evidence, "test", ["node", "node_modules/vitest/vitest.mjs", "run", "src/__tests__/misbehavior-loading.test.ts", "--maxWorkers=2", "--minWorkers=1"], { "AIMOCK_RPC_PROBE_DIR" => File.dirname(backup) }, deadline: total_deadline)
rescue StandardError => error
    exit_code = 1
    File.write(File.join(evidence, "failure.txt"), "#{error.class}: #{error.message}\n")
ensure
    if File.file?(backup)
        File.binwrite(dependency, File.binread(backup))
        restored = Digest::SHA256.file(dependency).hexdigest == Digest::SHA256.file(backup).hexdigest
        File.write(File.join(evidence, "restoration.json"), JSON.generate({ restored: restored, sha256: Digest::SHA256.file(dependency).hexdigest }) + "\n")
        exit_code = 1 unless restored
    end
    begin
        identity!(subject, evidence, "after")
        if Dir[File.join(evidence, "rpc", "rpc-*.jsonl")].any?
            capture!("ruby", File.join(helper_root, "summarize.rb"), File.join(evidence, "rpc"))
        end
    rescue StandardError => error
        File.write(File.join(evidence, "finalization-failure.txt"), "#{error.class}: #{error.message}\n")
        exit_code = 1
    end
    files = Dir[File.join(evidence, "**", "*")].select { |path| File.file?(path) }
    File.write(File.join(evidence, "sha256.txt"), files.map { |path| "#{Digest::SHA256.file(path).hexdigest} #{path.delete_prefix(evidence + "/")}" }.join("\n") + "\n")
end
exit exit_code
