#!/usr/bin/env node

import { main } from '../src/dev/peerSimulator';

const exitCode = await main(process.argv.slice(2));
process.exitCode = exitCode;
