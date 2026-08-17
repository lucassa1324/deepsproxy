/*
 * File: index.ts
 * Project: deepsproxy
 * API pública do Auto Router.
 */

export { routeRequest, updateAutoRouterConfig, getAutoRouterConfig, getAutoRouterStatus, clearDecisionCache } from './router.ts';
export { getModelMetadata, getAllModelMetadata, registerModel, setModelAvailability, syncWithCatalog, getModelsByTag } from './model-metadata.ts';
export { classifyTask, hasImageInput } from './task-classifier.ts';
export { selectBestModel } from './model-selector.ts';
export type { AutoRouterConfig, CostPolicy, RoutingDecision, TaskClassification, ModelMetadata, ModelCapabilities, ModelCost, ModelScore } from './types.ts';
