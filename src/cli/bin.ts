#!/usr/bin/env node
import { runLyncCli } from "./index.js";

const code = await runLyncCli(process.argv.slice(2));
process.exitCode = code;
