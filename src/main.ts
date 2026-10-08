#!/usr/bin/env node
import { failure, run, terminal } from "./cli.js";

const io = terminal();
run(process.argv.slice(2), io).then(
  (code) => {
    io.close();
    process.exitCode = code;
  },
  (e) => {
    io.close();
    const f = failure(e);
    console.error(f.message);
    process.exitCode = f.code;
  },
);
