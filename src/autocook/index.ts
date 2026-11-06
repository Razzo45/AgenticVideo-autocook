/**
 * Platform autocook API — importable without Next HITL.
 *
 *   import { planCook, generateSegment, assemble, runAutocook } from "./autocook";
 *
 * Flow: Argon brain plan → per-kind generation → deterministic assemble/export.
 */
export { planCook } from "./planCook";
export { generateSegment } from "./generateSegment";
export { assemble } from "./assemble";
export { runAutocook } from "./runAutocook";
export { preflightCook } from "./preflightCook";
export { rewriteSceneForFilter, applySceneRewrite } from "./rewriteScene";
export { inferCookKind } from "./inferCookKind";
export { splitCooks, normalizeCookSplit, fallbackCookSplit } from "./splitCooks";
export { generateHtml } from "./generateHtml";
export { generateImages } from "./generateImage";
export { generatePptx } from "./generatePptx";
export { exportPdf } from "./exportPdf";
export {
  ARGON_MEDIA_TOOL_DECLARATIONS,
  executeArgonMediaTool,
  materializePlanAssets,
  rewriteAssetPlaceholders,
} from "./argonMediaTools";
export type {
  AutocookMode,
  PlanCookInput,
  PlanCookResult,
  GenerateSegmentInput,
  GenerateSegmentResult,
  AssembleInput,
  AssembleResult,
  RunAutocookInput,
  RunAutocookResult,
} from "./types";
export type { PreflightCookInput, PreflightResult, PreflightRisk } from "./preflightCook";
export type {
  CookKind,
  HtmlPlan,
  ImagePlan,
  PptxPlan,
  PdfPlan,
  DocumentPlan,
} from "../pipeline/schemaDocs";
