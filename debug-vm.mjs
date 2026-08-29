import fs from 'fs';
import vm from 'vm';

const html = fs.readFileSync('src/ui/index.html', 'utf8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (scriptMatch) {
  const script = scriptMatch[1];
  // Extract the function body (remove IIFE wrapper)
  const body = script.replace(/^\(function \(\) \{\s*"use strict";\s*/, '').replace(/\s*\}\)\(\);\s*$/, '');
  console.log('Body length:', body.length);
  
  // Create a context with the globals the script expects
  const context = {
    document: {
      querySelector: () => null,
      querySelectorAll: () => [],
      getElementById: () => null,
    },
    window: {
      _lastStatus: null,
    },
    location: {
      origin: 'http://localhost:3005',
    },
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    EventSource: function() {},
    console: console,
    setTimeout: setTimeout,
    setInterval: setInterval,
    clearTimeout: clearTimeout,
    clearInterval: clearInterval,
    requestAnimationFrame: (cb) => cb(),
    cancelAnimationFrame: () => {},
    navigator: { clipboard: { writeText: async () => {} } },
    Blob: function() {},
    URL: URL,
    JSON: JSON,
    Object: Object,
    Array: Array,
    String: String,
    Number: Number,
    Boolean: Boolean,
    Date: Date,
    RegExp: RegExp,
    Error: Error,
    Promise: Promise,
    Map: Map,
    Set: Set,
    Symbol: Symbol,
    Math: Math,
    parseInt: parseInt,
    parseFloat: parseFloat,
    isNaN: isNaN,
    isFinite: isFinite,
    encodeURIComponent: encodeURIComponent,
    decodeURIComponent: decodeURIComponent,
    btoa: btoa,
    atob: atob,
  };
  
  // Add self-reference
  context.window.window = context.window;
  context.window.document = context.document;
  context.self = context.window;
  
  try {
    vm.runInNewContext(body, context, { filename: 'dashboard.js', displayErrors: true });
    console.log('Script executed successfully');
  } catch (e) {
    console.log('Error:', e.message);
    console.log('Stack:', e.stack);
  }
}