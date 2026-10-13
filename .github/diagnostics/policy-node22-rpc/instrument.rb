require "digest"
require "fileutils"

worktree = File.realpath(ARGV.fetch(0))
evidence = File.realpath(ARGV.fetch(1))
target = File.join(worktree, "node_modules/vitest/dist/chunks/index.B521nVV-.js")
original = File.binread(target)
File.binwrite(File.join(evidence, "birpc.original.js"), original)
source = original.dup
prefix = <<~'JS'
import { appendFileSync as __probeAppend } from 'node:fs';
import { monitorEventLoopDelay as __probeMonitor } from 'node:perf_hooks';
import { setInterval as __probeInterval } from 'node:timers';
import { createRequire as __probeRequire, syncBuiltinESMExports as __probeSyncExports } from 'node:module';
const __probeRoot = process.env.AIMOCK_RPC_PROBE_DIR;
const __probeCalls = new Map();
const __probeHistogram = __probeRoot ? __probeMonitor({ resolution: 20 }) : null;
__probeHistogram?.enable();
function __probeLog(event, details = {}) {
    if (!__probeRoot) return;
    __probeAppend(`${__probeRoot}/rpc-${process.pid}.jsonl`, JSON.stringify({
        event, time: Date.now(), mono: performance.now(), pid: process.pid,
        ppid: process.ppid, node: process.version, rss: process.memoryUsage().rss,
        loopMaxMs: __probeHistogram.max / 1e6,
        loopMeanMs: __probeHistogram.mean / 1e6,
        ...details
    }) + '\n');
}
function __probeTasks(args) {
    return (args?.[0] || []).map((pack) => pack?.[0]);
}
function __probeCollection(args) {
    const tasks = [];
    function walk(task, parentFile) {
        const file = task.filepath || task.file?.filepath || parentFile;
        tasks.push({ id: task.id, name: task.name, file, type: task.type });
        for (const child of task.tasks || []) walk(child, file);
    }
    for (const task of args?.[0] || []) walk(task);
    return tasks;
}
if (__probeRoot) {
    __probeLog('process-start');
    __probeInterval(() => { __probeLog('health'); __probeHistogram.reset(); }, 5000).unref();
    const childProcess = __probeRequire(import.meta.url)('node:child_process');
    const originalSpawnSync = childProcess.spawnSync;
    let sequence = 0;
    childProcess.spawnSync = function (...args) {
        const syncId = `${process.pid}-sync-${++sequence}`;
        const callsite = new Error().stack?.split('\n').slice(2, 5);
        __probeLog('sync-start', { syncId, callsite });
        try {
            return Reflect.apply(originalSpawnSync, this, args);
        } finally {
            __probeLog('sync-finish', { syncId });
        }
    };
    __probeSyncExports();
}
JS
source.prepend(prefix)
replacements = {
    'post(serialize({ m: method, a: args, t: TYPE_REQUEST }));' => "if (method === 'onCollected') __probeLog('collected', { tasks: __probeCollection(args) });\n        post(serialize({ m: method, a: args, t: TYPE_REQUEST }));",
    'const id = nanoid();' => "const id = nanoid();\n          if (method === 'onTaskUpdate') { __probeCalls.set(id, true); __probeLog('send-call', { id, tasks: __probeTasks(args), timeout }); }",
    'const handleResult = options.onTimeoutError?.(method, args);' => "if (method === 'onTaskUpdate') __probeLog('timeout', { id, tasks: __probeTasks(args), timeout });\n                const handleResult = options.onTimeoutError?.(method, args);",
    'const { m: method, a: args } = msg;' => "const { m: method, a: args } = msg;\n      if (method === 'onTaskUpdate') __probeLog('receive-call', { id: msg.i, tasks: __probeTasks(args) });",
    'result = await fn.apply(bind === "rpc" ? rpc : functions, args);' => "if (method === 'onTaskUpdate') __probeLog('handler-start', { id: msg.i });\n          result = await fn.apply(bind === \"rpc\" ? rpc : functions, args);\n          if (method === 'onTaskUpdate') __probeLog('handler-finish', { id: msg.i });",
    'post(serialize({ t: TYPE_RESPONSE, i: msg.i, r: result }), ...extra);' => "if (method === 'onTaskUpdate') __probeLog('send-ack', { id: msg.i });\n            post(serialize({ t: TYPE_RESPONSE, i: msg.i, r: result }), ...extra);",
    'const { i: ack, r: result, e: error } = msg;' => "const { i: ack, r: result, e: error } = msg;\n      if (__probeCalls.has(ack)) { __probeLog('receive-ack', { id: ack, error: error?.message }); __probeCalls.delete(ack); }"
}
replacements.each do |before, after|
    abort "Expected one instrumentation site: #{before}" unless source.scan(before).length == 1
    source.sub!(before, after)
end
File.binwrite(target, source)
File.write(File.join(evidence, "instrumentation-hashes.txt"), "original #{Digest::SHA256.hexdigest(original)}\ninstrumented #{Digest::SHA256.hexdigest(source)}\n")
puts "Instrumented own dependency #{File.realpath(target)}"
