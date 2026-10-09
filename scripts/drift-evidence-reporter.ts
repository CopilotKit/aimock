import { writeFileSync } from "node:fs";
import type { Reporter } from "vitest/reporters";

type TestCase = Parameters<NonNullable<Reporter["onTestCaseResult"]>>[0];
type TestSuite = Parameters<NonNullable<Reporter["onTestSuiteResult"]>>[0];
type TestModule = Parameters<NonNullable<Reporter["onTestModuleEnd"]>>[0];

export type EvidenceReporterRecord =
  | { kind: "console"; taskId: string; stream: "stdout" | "stderr"; content: string }
  | {
      kind: "identity";
      id: string;
      entity: "test" | "suite" | "module";
      file: string;
      ancestors: string[];
      title: string;
    }
  | { kind: "unavailable" }
  | { kind: "complete" };

export const MAX_EVIDENCE_RECORD_BYTES = 256 * 1024;

// Private parent pipe only. No stdout, disk artifacts, provider interpretation,
// or header-text parsing: console content cannot mint an entity identity.
export default class DriftEvidenceReporter implements Reporter {
  private broken = false;

  private emit(record: EvidenceReporterRecord) {
    if (this.broken) return;
    try {
      const encoded = JSON.stringify(record);
      writeFileSync(
        3,
        (Buffer.byteLength(encoded) <= MAX_EVIDENCE_RECORD_BYTES
          ? encoded
          : '{"kind":"unavailable"}') + "\n",
      );
    } catch {
      this.broken = true;
      // A missing completion record makes the parent mark the channel unavailable.
    }
  }

  private identity(entity: TestCase | TestSuite | TestModule) {
    try {
      const ancestors: string[] = [];
      if (entity.type !== "module") {
        let parent = entity.parent;
        while (parent.type !== "module") {
          ancestors.unshift(parent.name);
          parent = parent.parent;
        }
      }
      this.emit({
        kind: "identity",
        id: entity.id,
        entity: entity.type,
        file: entity.type === "module" ? entity.moduleId : entity.module.moduleId,
        ancestors,
        title: entity.type === "module" ? "" : entity.name,
      });
    } catch {
      this.emit({ kind: "unavailable" });
    }
  }

  onUserConsoleLog: NonNullable<Reporter["onUserConsoleLog"]> = (log) => {
    this.emit({
      kind: "console",
      taskId: log.taskId ?? "",
      stream: log.type,
      content: log.content,
    });
  };

  onTestCaseResult(test: TestCase) {
    this.identity(test);
  }
  onTestSuiteResult(suite: TestSuite) {
    this.identity(suite);
  }
  onTestModuleEnd(module: TestModule) {
    this.identity(module);
  }
  onFinished() {
    this.emit({ kind: "complete" });
  }
}
