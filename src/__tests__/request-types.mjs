import * as path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import ts from "typescript";

const { root, source } = workerData;
const consumer = path.resolve(root, "src/__tests__/consumer.4d8b73.ts");
const config = ts.readConfigFile(path.resolve(root, "tsconfig.json"), ts.sys.readFile);
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
const options = {
  ...parsed.options,
  noEmit: true,
  baseUrl: root,
  paths: { "@copilotkit/aimock": ["src/index.ts"] },
};
const host = ts.createCompilerHost(options);
const originalRead = host.readFile.bind(host);
const originalExists = host.fileExists.bind(host);
host.readFile = (file) => (path.resolve(file) === consumer ? source : originalRead(file));
host.fileExists = (file) => path.resolve(file) === consumer || originalExists(file);
const program = ts.createProgram([consumer], options, host);
const errors = [config.error, ...parsed.errors, ...ts.getPreEmitDiagnostics(program)].filter(
  (diagnostic) => diagnostic?.category === ts.DiagnosticCategory.Error,
);
parentPort.postMessage(
  ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }),
);
