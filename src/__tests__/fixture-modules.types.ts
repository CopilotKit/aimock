import { LLMock, loadFixtureModule } from "../index.js";
import type { Fixture, FixtureModuleOptions } from "../index.js";

const options: FixtureModuleOptions = {
  parameters: { value: { list: [0, false, null, ""] } },
  maxDepth: 4,
  maxFixtures: 20,
};
const fixtures: Fixture[] = loadFixtureModule("module.json", options);
const mock: LLMock = new LLMock().loadFixtureModule("module.json", options);
void fixtures;
void mock;

const mounted: LLMock = mock.mountFixtureModule("module", "module.json", options);
const count: number = mounted.reloadFixtureModules(["module.json"]);
const removed: boolean = mounted.unmountFixtureModule("module");
const info: readonly import("../index.js").FixtureModuleInfo[] = mounted.getFixtureModules();
void count;
void removed;
void info;
