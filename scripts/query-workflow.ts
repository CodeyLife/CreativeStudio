import { Connection, Client } from "@temporalio/client";

const workflowId = process.argv[2];

async function main() {
  const connection = await Connection.connect({ address: process.env.TEMPORAL_ADDRESS ?? "127.0.0.1:7233" });
  const client = new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? "default" });
  const handle = client.workflow.getHandle(workflowId);

  const history = await handle.fetchHistory();
  // fetchHistory 对已清理/不存在的运行可返回无 events 的历史对象。
  const events = history.events ?? [];
  console.log(`Total events: ${events.length}`);
  for (const event of events) {
    const eventType = (event as any).eventType;
    // 3 = WORKFLOW_EXECUTION_FAILED, 8 = ACTIVITY_TASK_FAILED
    if (eventType === 3 || eventType === 8) {
      console.log(`\n=== EVENT ${event.eventId} (type=${eventType}) ===`);
      console.log(JSON.stringify(event, null, 2));
    }
  }
  await connection.close();
}

main().catch(console.error);
