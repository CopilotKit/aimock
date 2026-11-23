import { A2AMock, type A2AConversationTurn, type A2AConversationOptions } from "../index.js";
import {
  A2AMock as SubpathMock,
  type A2AConversationTurn as SubpathTurn,
  type A2AConversationOptions as SubpathOptions,
} from "../a2a-stub.js";
import type { AimockConfig } from "../config-loader.js";

const turn: A2AConversationTurn = {
  pattern: /hello/,
  response: { state: "TASK_STATE_COMPLETED", parts: [{ text: "hi" }] },
};
const copy: SubpathTurn = turn;
const options: A2AConversationOptions = { replayLimit: 2 };
const subpathOptions: SubpathOptions = options;
const root: A2AMock = new A2AMock()
  .registerAgent({ name: "agent" })
  .onConversation("agent", [turn], options);
const subpath: SubpathMock = new SubpathMock()
  .registerAgent({ name: "agent" })
  .onConversation("agent", [copy], subpathOptions);
const config: AimockConfig = {
  a2a: {
    agents: [
      {
        name: "agent",
        conversations: [
          {
            turns: [{ pattern: "hello", response: { state: "TASK_STATE_COMPLETED" } }],
            replayLimit: 2,
          },
        ],
      },
    ],
  },
};
void [root, subpath, config];
