import { useEffect, useRef, useState } from "react";
import { cacheKeyFor, isFresh, readCache, writeCache, writeInflight } from "../queryCache";

/**
 * Client cache for GET-style loaders.
 *
 * Every page used to refetch its data on mount and clear the table while doing
 * it, so moving between pages re-showed a spinner and paid the full round trip
 * (seconds on the 50M-row dataset) again. Entries are keyed by the loader source
 * plus its dependency values, kept briefly, and shared with in-flight requests
 * so React StrictMode's double effect cannot fire two identical queries.
 */
export function useRequest(loader, dependencies = []) {
  const key = cacheKeyFor(loader, dependencies);
  const [state, setState] = useState(() => {
    const cached = readCache(key);
    return cached?.data
      ? { data: cached.data, error: null, loading: false, refreshing: false }
      : { data: null, error: null, loading: true, refreshing: false };
  });
  const [reloadKey, setReloadKey] = useState(0);
  const keyRef = useRef(key);
  const forceRef = useRef(false);

  useEffect(() => {
    let active = true;
    const currentKey = key;
    const cached = readCache(currentKey);
    const keyChanged = keyRef.current !== currentKey;
    const force = forceRef.current || keyChanged;
    keyRef.current = currentKey;
    forceRef.current = false;

    // Fresh enough: render from cache and skip the network entirely.
    if (isFresh(cached) && !force) {
      setState({ data: cached.data, error: null, loading: false, refreshing: false });
      return () => {
        active = false;
      };
    }

    const previous = cached?.data ?? null;
    setState((current) => ({
      data: previous ?? (keyChanged ? null : current.data),
      error: null,
      loading: previous === null && current.data === null,
      refreshing: previous !== null || current.data !== null,
    }));

    let promise = cached?.promise;
    if (!promise) {
      promise = Promise.resolve().then(loader);
      writeInflight(currentKey, previous, cached?.at ?? 0, promise);
    }

    promise
      .then((data) => {
        writeCache(currentKey, data);
        if (active) setState({ data, error: null, loading: false, refreshing: false });
      })
      .catch((error) => {
        writeInflight(currentKey, previous, cached?.at ?? 0, null);
        if (active) {
          setState((current) => ({
            data: current.data ?? previous,
            error,
            loading: false,
            refreshing: false,
          }));
        }
      });

    return () => {
      active = false;
    };
  }, [key, reloadKey]);

  return {
    ...state,
    reload: () => {
      forceRef.current = true;
      setReloadKey((value) => value + 1);
    },
  };
}
