require "json"

root = File.realpath(ARGV.fetch(0))
calls = {}
sync_calls = {}
tasks = {}
processes = {}
events = Hash.new(0)
Dir[File.join(root, "rpc-*.jsonl")].each do |path|
    File.foreach(path) do |line|
        event = JSON.parse(line)
        events[event.fetch("event")] += 1
        process = (processes[event.fetch("pid")] ||= { "node" => event["node"], "ppid" => event["ppid"], "maxRss" => 0, "maxLoopMs" => 0 })
        process["maxRss"] = [process["maxRss"], event["rss"]].max
        process["maxLoopMs"] = [process["maxLoopMs"], event["loopMaxMs"] || 0].max
        if event["event"] == "collected"
            event.fetch("tasks").each { |task| tasks[task.fetch("id")] = task }
        end
        if event["syncId"]
            sync_call = (sync_calls[event["syncId"]] ||= {})
            sync_call[event.fetch("event")] = event
        end
        next unless event["id"]
        call = (calls[event["id"]] ||= {})
        call[event.fetch("event")] = event
    end
end
stages = {
    "callToAckMs" => ["send-call", "receive-ack"],
    "callToReceiveMs" => ["send-call", "receive-call"],
    "handlerMs" => ["handler-start", "handler-finish"],
    "ackTransportMs" => ["send-ack", "receive-ack"]
}
ranked = {}
stages.each do |label, (start_event, end_event)|
    ranked[label] = calls.map do |id, call|
        next unless call[start_event] && call[end_event]
        {
            "id" => id,
            "durationMs" => call[end_event]["time"] - call[start_event]["time"],
            "senderPid" => call["send-call"]&.fetch("pid"),
            "tasks" => (call["send-call"]&.fetch("tasks") || []).map { |task| tasks[task] || { "id" => task } }
        }
    end.compact.sort_by { |call| -call["durationMs"] }.first(5)
end
result = {
    "events" => events,
    "mappedTasks" => tasks.size,
    "processes" => processes,
    "timeoutCalls" => calls.select { |_, call| call.key?("timeout") },
    "unacknowledgedCalls" => calls.select { |_, call| call.key?("send-call") && !call.key?("receive-ack") },
    "longestStages" => ranked,
    "longestSyncCalls" => sync_calls.map do |id, call|
        next unless call["sync-start"] && call["sync-finish"]
        {
            "id" => id,
            "pid" => call["sync-start"]["pid"],
            "startTime" => call["sync-start"]["time"],
            "endTime" => call["sync-finish"]["time"],
            "durationMs" => call["sync-finish"]["mono"] - call["sync-start"]["mono"],
            "callsite" => call["sync-start"]["callsite"]
        }
    end.compact.sort_by { |call| -call["durationMs"] }.first(10)
}
File.write(File.join(root, "summary.json"), JSON.pretty_generate(result) + "\n")
puts JSON.generate({ "events" => events, "mappedTasks" => tasks.size, "processCount" => processes.size, "timeouts" => result["timeoutCalls"].size, "unacknowledged" => result["unacknowledgedCalls"].size, "maxRss" => processes.values.map { |v| v["maxRss"] }.max, "maxLoopMs" => processes.values.map { |v| v["maxLoopMs"] }.max, "maxCallMs" => ranked["callToAckMs"].first&.fetch("durationMs"), "maxHandlerMs" => ranked["handlerMs"].first&.fetch("durationMs") })
