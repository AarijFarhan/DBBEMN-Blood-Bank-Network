import { useState } from "react";

/**
 * Manages page state for paginated API calls.
 *
 * Usage:
 *   const { page, limit, resetPage, nextPage, prevPage } = usePagination();
 *   const request = useRequest(() => api.units.list({ page, limit }), [page, status]);
 *   // When filter changes, call resetPage() to go back to page 1.
 */
export function usePagination({ defaultLimit = 25 } = {}) {
  const [page, setPage] = useState(1);
  const limit = defaultLimit;

  function nextPage() {
    setPage((current) => current + 1);
  }

  function prevPage() {
    setPage((current) => Math.max(1, current - 1));
  }

  function resetPage() {
    setPage(1);
  }

  return { page, limit, nextPage, prevPage, resetPage, setPage };
}
