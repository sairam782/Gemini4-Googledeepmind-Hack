// Re-export the native module. On web, it will be resolved to CallScreenerModule.web.ts
// and on native platforms to CallScreenerModule.ts
export { default } from './src/CallScreenerModule';
export * from './src/CallScreener.types';
