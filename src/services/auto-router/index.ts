/*
 * File: index.ts
 * Project: deepsproxy
 * API pública do Auto Router.
 */

export { routeRequest, updateAutoRouterConfig, getAutoRouterConfig, getAutoRouterStatus, clearDecisionCache, getPreviousAutoModel, rememberAutoModel, clearConversationMemory, buildAutoFailoverChain } from './router.ts';
export { getModelMetadata, getAllModelMetadata, registerModel, setModelAvailability, syncWithCatalog, getModelsByTag, isModelDown, recordModelFailure, recordModelSuccess, getModelHealthState, resetModelHealth, inferCapabilities, recordModelRequest, recordModelLatency, recordModelOutcome, getModelMetrics, getModelMetricsFor, resetModelMetrics, classifyFailure, isProviderDown, recordProviderFailure, recordProviderSuccess, getProviderHealthState, resetProviderHealth, snapshotModelHealth, restoreModelHealth, snapshotProviderHealth, restoreProviderHealth, snapshotModelMetrics, restoreModelMetrics } from './model-metadata.ts';
export { classifyTask, hasImageInput } from './task-classifier.ts';
export { selectBestModel } from './model-selector.ts';
export { initRouterPersistence, flushRouterState, stopRouterPersistence, isRouterPersistenceEnabled } from './persistence.ts';
export type { AutoRouterConfig, CostPolicy, RoutingDecision, TaskClassification, ModelMetadata, ModelCapabilities, ModelCost, ModelScore, ScoringContext } from './types.ts';
export type { FailureKind } from './model-metadata.ts';
