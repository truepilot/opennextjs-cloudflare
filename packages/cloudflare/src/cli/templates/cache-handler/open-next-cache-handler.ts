import type {
  CacheHandler,
  CacheHandlerContext,
  CacheHandlerValue,
} from "next/dist/server/lib/incremental-cache";
import type { IncrementalCacheValue } from "next/dist/server/response-cache";

import {
  NEXT_BODY_SUFFIX,
  NEXT_DATA_SUFFIX,
  NEXT_HTML_SUFFIX,
  RSC_PREFETCH_SUFFIX,
  RSC_SUFFIX,
  SEED_DATA_DIR,
} from "../../constants/incremental-cache";
import type { CacheEntry, CacheStore } from "./cache-store";
import { getCacheStore } from "./cache-store";
import { getSeedBodyFile, getSeedMetaFile, getSeedTextFile, parseCtx } from "./utils";

export class OpenNextCacheHandler implements CacheHandler {
  protected cache: CacheStore | undefined;

  protected debug: boolean = !!process.env.NEXT_PRIVATE_DEBUG_CACHE;

  constructor(protected ctx: CacheHandlerContext) {
    this.cache = getCacheStore();
  }

  async get(...args: Parameters<CacheHandler["get"]>): Promise<CacheHandlerValue | null> {
    const [key, _ctx] = args;
    const ctx = parseCtx(_ctx);

    if (this.debug) console.log(`cache - get: ${key}, ${ctx?.kind}`);

    if (this.cache !== undefined) {
      try {
        const value = await this.cache.get(key);
        if (value) return value;
      } catch (e) {
        console.error(`Failed to get value for key = ${key}: ${e}`);
      }
    }

    // Check for seed data from the file-system.

    // we don't check for seed data for fetch or image cache entries
    if (ctx?.kind === "FETCH" || ctx?.kind === "IMAGE") return null;

    const seedKey = `http://assets.local/${SEED_DATA_DIR}/${key}`.replace(/\/\//g, "/");

    if (ctx?.kind === "APP" || ctx?.kind === "APP_ROUTE") {
      const fallbackBody = await getSeedBodyFile(seedKey, NEXT_BODY_SUFFIX);
      if (fallbackBody) {
        const meta = await getSeedMetaFile(seedKey);
        return {
          lastModified: meta?.lastModified,
          value: {
            kind: (ctx.kind === "APP_ROUTE" ? ctx.kind : "ROUTE") as Extract<
              IncrementalCacheValue["kind"],
              "ROUTE"
            >,
            body: fallbackBody,
            status: meta?.status ?? 200,
            headers: meta?.headers ?? {},
          },
        };
      }

      if (ctx.kind === "APP_ROUTE") {
        return null;
      }
    }

    const seedHtml = await getSeedTextFile(seedKey, NEXT_HTML_SUFFIX);
    if (!seedHtml) return null; // we're only checking for prerendered routes at the moment

    if (ctx?.kind === "PAGES" || ctx?.kind === "APP" || ctx?.kind === "APP_PAGE") {
      const metaPromise = getSeedMetaFile(seedKey);

      let pageDataPromise: Promise<Buffer | string | undefined> = Promise.resolve(undefined);
      if (!ctx.isFallback) {
        const rscSuffix = ctx.isRoutePPREnabled ? RSC_PREFETCH_SUFFIX : RSC_SUFFIX;

        if (ctx.kind === "APP_PAGE") {
          pageDataPromise = getSeedBodyFile(seedKey, rscSuffix);
        } else {
          pageDataPromise = getSeedTextFile(seedKey, ctx.kind === "APP" ? rscSuffix : NEXT_DATA_SUFFIX);
        }
      }

      const [meta, pageData] = await Promise.all([metaPromise, pageDataPromise]);

      return {
        lastModified: meta?.lastModified,
        value: {
          kind: (ctx.kind === "APP_PAGE" ? "APP_PAGE" : "PAGE") as Extract<
            IncrementalCacheValue["kind"],
            "PAGE"
          >,
          html: seedHtml,
          pageData: pageData ?? "",
          ...(ctx.kind === "APP_PAGE" && { rscData: pageData }),
          postponed: meta?.postponed,
          status: meta?.status,
          headers: meta?.headers,
        },
      };
    }

    return null;
  }

  async set(...args: Parameters<CacheHandler["set"]>) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const [key, entry, _ctx] = args;

    if (this.cache === undefined) {
      return;
    }

    if (this.debug) console.log(`cache - set: ${key}`);

    const data: CacheEntry = {
      lastModified: Date.now(),
      value: entry,
    };

    try {
      await this.cache.put(key, data);
    } catch (e) {
      console.error(`Failed to set value for key = ${key}: ${e}`);
    }
  }

  async revalidateTag(...args: Parameters<CacheHandler["revalidateTag"]>) {
    const [tags] = args;
    if (this.cache === undefined) {
      return;
    }

    if (this.debug) console.log(`cache - revalidateTag: ${JSON.stringify([tags].flat())}`);
  }

  resetRequestCache(): void {}
}
