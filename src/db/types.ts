import type { Gate, OutputResolution, PipelineMode, RunStatus } from "../pipeline/constants";

export type RunRow = {
  id: string;
  session_id: string;
  status: RunStatus;
  category: string;
  aspect_ratio: string;
  target_duration: number;
  output_resolution: OutputResolution;
  initial_prompt: string;
  script_model: string;
  keyframe_model: string;
  video_model: string;
  current_shot_index: number;
  rework_round: number;
  gate: Gate | null;
  revise_comment: string | null;
  script_json: string | null;
  input_assets_json: string | null;
  pipeline_mode: PipelineMode;
  operator_script: string | null;
  auto_options_json: string | null;
  error: string | null;
  counted: number;
  user_id: string;
  tenant_id: string | null;
  created_by_kind: string;
  created_at: string;
  updated_at: string;
};

export type VariantRow = {
  id: string;
  run_id: string;
  shot_index: number;
  kind: "keyframe" | "clip";
  variant_index: number;
  path: string;
  prompt: string;
  model_name: string;
  selected: number;
  rejected: number;
  probe_json: string | null;
  uniq_id: string | null;
  created_at: string;
};

export type AssetRow = {
  uniq_id: string;
  run_id: string;
  shot_index: number | null;
  role: string;
  path: string;
  parent_uniq_id: string | null;
  meta_json: string;
  created_at: string;
};

export type JobRow = {
  id: string;
  run_id: string;
  type: string;
  status: "pending" | "running" | "done" | "error";
  weight: number;
  /** Sum of deliverable units. Lower is admitted first. */
  task_weight: number;
  heavy: number;
  archive: number;
  payload_json: string;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type ReviewRow = {
  run_id: string;
  gate: Gate;
  checklist_json: string | null;
  aesthetic_score: number | null;
  consistency_score: number | null;
  use_xfade: number;
  updated_at: string;
};
