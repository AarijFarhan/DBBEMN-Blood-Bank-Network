import { useEffect, useState } from "react";

export function useRequest(loader, dependencies = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let active = true;
    setState({ data: null, error: null, loading: true });
    Promise.resolve()
      .then(loader)
      .then((data) => {
        if (active) setState({ data, error: null, loading: false });
      })
      .catch((error) => {
        if (active) setState({ data: null, error, loading: false });
      });
    return () => {
      active = false;
    };
  }, [...dependencies, reloadKey]);

  return {
    ...state,
    reload: () => setReloadKey((value) => value + 1),
  };
}
