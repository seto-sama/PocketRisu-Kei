import { type HypaModel, DEFAULT_HYPA_MODEL, getPersistedHypaVectors, hypaVectorCache, setPersistedHypaVector, HypaProcesser, chunkEmbeddingInputs, type VectorArray } from "./hypamemory";
import { isContextModel, getContextProvider } from "./contextualEmbedding";
import { TaskConcurrencyLimiter, TaskCanceledError } from "./taskConcurrencyLimiter";
import { getDatabase } from "src/ts/storage/database.svelte";

export interface HypaEmbeddingProcessorOptions {
  model?: HypaModel;
  customEmbeddingUrl?: string;
  oaiKey?: string;
  concurrencyLimiter?: TaskConcurrencyLimiter;
}

export interface EmbeddingText<TMetadata> {
  id: string;
  content: string;
  metadata?: TMetadata;
}

export interface EmbeddingResult<TMetadata> extends EmbeddingText<TMetadata> {
  embedding: VectorArray;
}

export class HypaEmbeddingProcessor<TMetadata> {
  public readonly options: HypaEmbeddingProcessorOptions;
  public progressCallback: (queuedCount: number) => void = null;
  public vectors: Map<string, EmbeddingResult<TMetadata>> = new Map();

  public constructor(options?: HypaEmbeddingProcessorOptions) {
    const db = getDatabase();

    this.options = {
      model: db.hypaModel || DEFAULT_HYPA_MODEL,
      customEmbeddingUrl: db.hypaCustomSettings?.url?.trim() || "",
      oaiKey: db.supaMemoryKey?.trim() || "",
      concurrencyLimiter: new TaskConcurrencyLimiter(),
      ...options,
    };
  }

  public async addTexts(ebdTexts: EmbeddingText<TMetadata>[]): Promise<void> {
    await this.getEmbeds(ebdTexts, true);
  }

  public async similaritySearchScoredBatch(
    queries: string[]
  ): Promise<[EmbeddingResult<TMetadata>, number][][]> {
    if (queries.length === 0) {
      return [];
    }

    const uniqueQueries = [...new Set(queries)];

    const ebdTexts: EmbeddingText<TMetadata>[] = uniqueQueries.map(
      (query, index) => ({
        id: `query-${index}`,
        content: query,
      })
    );

    const ebdResults = await this.getEmbeds(ebdTexts, false);

    const scoredResultsMap = new Map<
      string,
      [EmbeddingResult<TMetadata>, number][]
    >();

    for (let i = 0; i < uniqueQueries.length; i++) {
      const ebdResult = ebdResults[i];

      const scoredVectors = Array.from(this.vectors.values())
        .map((vector): [EmbeddingResult<TMetadata>, number] => [
          vector,
          this.similarity(ebdResult.embedding, vector.embedding),
        ])
        .sort((a, b) => b[1] - a[1]);

      scoredResultsMap.set(uniqueQueries[i], scoredVectors);
    }

    return queries.map((query) => scoredResultsMap.get(query));
  }

  private async getEmbeds(
    ebdTexts: EmbeddingText<TMetadata>[],
    saveToMemory: boolean = true
  ): Promise<EmbeddingResult<TMetadata>[]> {
    if (ebdTexts.length === 0) {
      return [];
    }

    const resultMap: Map<string, EmbeddingResult<TMetadata>> = new Map();
    const toEmbed: EmbeddingText<TMetadata>[] = [];

    const ctxProvider = isContextModel(this.options.model) ? getContextProvider(this.options.model) : null;
    const ctxGroups = new Map<string, string[]>();
    if (ctxProvider && saveToMemory) {
      const groups = new Map<TMetadata, EmbeddingText<TMetadata>[]>();
      for (const item of ebdTexts) {
        const g = groups.get(item.metadata) || [];
        g.push(item);
        groups.set(item.metadata, g);
      }
      for (const [, g] of groups) {
        const texts = g.map(item => item.content);
        for (const item of g) {
          ctxGroups.set(item.id, texts);
        }
      }
    }

    const cacheItems = ebdTexts.filter(item => {
      if (!this.vectors.has(item.id)) return true;
      resultMap.set(item.id, this.vectors.get(item.id));
      return false;
    });
    const cacheKeys = cacheItems.map(item => this.getCacheKey(item.content, ctxGroups.get(item.id)));
    const cachedVectors = await getPersistedHypaVectors(cacheKeys)
      .catch(() => cacheKeys.map(key => hypaVectorCache.get(key)));

    cacheItems.forEach((item, index) => {
      const { id, metadata } = item;
      const cached = cachedVectors[index];
      if (cached) {
        // Keep request metadata separate from the shared cached vector.
        const ebdResult: EmbeddingResult<TMetadata> = { ...cached, id, metadata };

        if (saveToMemory) {
          this.vectors.set(id, ebdResult);
        }

        resultMap.set(id, ebdResult);
      } else {
        toEmbed.push(item);
      }
    });

    if (ctxProvider && toEmbed.length > 0 && saveToMemory) {
      const missMetadatas = new Set(
        toEmbed.map((item) => item.metadata).filter(Boolean)
      );
      const missingIds = new Set(toEmbed.map((item) => item.id));

      const additionalItems = ebdTexts.filter(
        (item) =>
          item.metadata &&
          missMetadatas.has(item.metadata) &&
          !missingIds.has(item.id)
      );

      for (const item of additionalItems) {
        resultMap.delete(item.id);
        this.vectors.delete(item.id);
      }

      toEmbed.push(...additionalItems);
    }

    if (toEmbed.length === 0) {
      return ebdTexts.map((item) => resultMap.get(item.id));
    }

    if (ctxProvider && saveToMemory) {
      const metadataGroups = new Map<TMetadata, EmbeddingText<TMetadata>[]>();
      for (const item of toEmbed) {
        const key = item.metadata;
        const group = metadataGroups.get(key) || [];
        group.push(item);
        metadataGroups.set(key, group);
      }

      const groupEntries = Array.from(metadataGroups.entries());
      const groups = groupEntries.map(([, group]) =>
        group.map((item) => item.content)
      );

      const results = await ctxProvider.embedDocumentGroups(groups);

      for (let i = 0; i < groupEntries.length; i++) {
        const [, group] = groupEntries[i];
        const embeddings = results[i];

        for (let j = 0; j < group.length; j++) {
          const { id, content, metadata } = group[j];
          const embedding = embeddings[j];

          const ebdResult: EmbeddingResult<TMetadata> = {
            id, content, embedding, metadata
          };

          await setPersistedHypaVector(this.getCacheKey(content, ctxGroups.get(id)), {
            content, embedding
          });

          this.vectors.set(id, ebdResult);
          resultMap.set(id, ebdResult);
        }
      }
    } else {
      const chunks = chunkEmbeddingInputs(toEmbed);
      const processor = new HypaProcesser(this.options.model, this.options.customEmbeddingUrl);
      processor.oaikey = this.options.oaiKey;
      const embeddingTasks = chunks.map((chunk) => {
        const contents = chunk.map((item) => item.content);

        return () => processor.getEmbeds(contents, saveToMemory ? "document" : "query");
      });

      this.options.concurrencyLimiter.taskQueueChangeCallback = this.progressCallback;

      const batchResult = await this.options.concurrencyLimiter.executeBatch<
        VectorArray[]
      >(embeddingTasks);
      const errors: Error[] = [];

      const chunksSavePromises = batchResult.results.map(async (result, i) => {
        if (!result.success) {
          errors.push(result.error);
          return;
        }

        const chunk = chunks[i];
        const savePromises = result.data.map(async (embedding, j) => {
          const { id, content, metadata } = chunk[j];

          const ebdResult: EmbeddingResult<TMetadata> = {
            id,
            content,
            embedding,
            metadata,
          };

          await setPersistedHypaVector(this.getCacheKey(content, ctxGroups.get(id)), {
            content,
            embedding,
          });

          if (saveToMemory) {
            this.vectors.set(id, ebdResult);
          }

          resultMap.set(id, ebdResult);
        });

        await Promise.all(savePromises);
      });

      await Promise.all(chunksSavePromises);

      if (errors.length > 0) {
        const majorError =
          errors.find((error) => !(error instanceof TaskCanceledError)) ||
          errors[0];

        throw majorError;
      }
    }

    return ebdTexts.map((item) => resultMap.get(item.id));
  }

  private similarity(a: VectorArray, b: VectorArray): number {
    let dot = 0;
    let magA = 0;
    let magB = 0;

    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      magA += a[i] * a[i];
      magB += b[i] * b[i];
    }

    return dot / (Math.sqrt(magA) * Math.sqrt(magB));
  }

  private getCacheKey(content: string, contextTexts?: string[]): string {
    const db = getDatabase();
    const suffix =
      this.options.model === "custom" && db.hypaCustomSettings?.model?.trim()
        ? `-${db.hypaCustomSettings.model.trim()}`
        : "";

    const ctxProvider = isContextModel(this.options.model) ? getContextProvider(this.options.model) : null;
    const ctxSuffix = ctxProvider
      ? ctxProvider.getCacheKeySuffix(contextTexts)
      : "";

    return `${content}|${this.options.model}${suffix}${ctxSuffix}`;
  }
}
