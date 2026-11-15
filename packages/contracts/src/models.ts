import { z } from 'zod';

/** A model identity selected from the host's available catalogue. */
export type ModelReference = {
  readonly provider: string;
  readonly id: string;
};

/** Display metadata for an available model, without credentials or deployment endpoints. */
export interface ModelOption extends ModelReference {
  readonly name: string;
  readonly reasoningEfforts: readonly string[];
}

/** Models enabled by the host and its configured default selection. */
export type ModelCatalog = {
  readonly models: readonly ModelOption[];
  readonly defaultModel: ModelReference | null;
};

const MODEL_FIELDS = {
  provider: z.string().trim().min(1).max(200),
  id: z.string().trim().min(1).max(300),
};

/** Validates identity shape; the host separately checks availability and access. */
export const MODEL_REFERENCE_SCHEMA: z.ZodType<ModelReference> = z.strictObject(MODEL_FIELDS);

/** Validates the catalogue's public allowlist. */
export const MODEL_CATALOG_SCHEMA: z.ZodType<ModelCatalog> = z.object({
  models: z.array(
    z.object({
      ...MODEL_FIELDS,
      name: z.string().min(1),
      reasoningEfforts: z.array(z.string().min(1)).min(1),
    }),
  ),
  defaultModel: MODEL_REFERENCE_SCHEMA.nullable(),
});
