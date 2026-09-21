#!/usr/bin/env node
import { Command } from 'commander';
import { runInit } from './commands/init';
import { runIndex } from './commands/indexCmd';
import { runStatus } from './commands/status';
import { runSearch } from './commands/search';
import { runContext } from './commands/context';
import { runSetup } from './commands/setup';
import { runMcp } from './commands/mcp';

const program = new Command();
program.version('1.0.0').description('Framer CLI - Local AI Context System');

const getRoot = () => process.cwd();

program.command('init')
    .description('Initialize Framer in the repository')
    .action(() => runInit(getRoot()));

program.command('index')
    .description('Build or update the local codebase index')
    .action(() => runIndex(getRoot()));

program.command('status')
    .description('Check working tree status against the index')
    .action(() => runStatus(getRoot()));

program.command('search <query>')
    .description('Search the indexed codebase')
    .action((query) => runSearch(getRoot(), query));

program.command('context <task>')
    .description('Generate context package for a specific task')
    .action((task) => runContext(getRoot(), task));

program.command('setup')
    .description('Print the configuration for AI clients')
    .action(() => runSetup(getRoot()));

program.command('mcp')
    .description('Run the Framer MCP Server over stdio')
    .action(() => runMcp(getRoot()));

program.parse(process.argv);