"""Background job manager — runs async coroutines as tracked jobs."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, Awaitable, Callable

logger = logging.getLogger(__name__)


class JobManager:
    """Manages background asyncio tasks with database-backed state tracking."""

    def __init__(self, store: Any) -> None:
        self.store = store
        self._tasks: dict[str, asyncio.Task] = {}

    def cleanup_dangling_jobs(self) -> int:
        """Mark any pending/running jobs from a previous process as failed."""
        count = self.store.cleanup_dangling_jobs()
        if count > 0:
            logger.info(f"Cleaned up {count} dangling job(s) from previous run")
        return count

    async def submit(
        self,
        job_type: str,
        coro_factory: Callable[[str], Awaitable[dict[str, Any]]],
        user_id: str | None = None,
    ) -> dict[str, Any]:
        """Create a job record and launch the coroutine as a background task.

        ``coro_factory`` receives the ``job_id`` so the running job can report
        progress via ``store.update_job_status(job_id, ...)``.
        """
        job = self.store.create_job(job_type, user_id=user_id)
        job_id = job["id"]

        async def _run() -> None:
            try:
                self.store.update_job_status(job_id, "running")
                result = await coro_factory(job_id)
                self.store.update_job_status(job_id, "completed", result=result)
                logger.info(f"Job {job_id} ({job_type}) completed")
            except asyncio.CancelledError:
                self.store.update_job_status(job_id, "failed", error="Cancelled")
                logger.info(f"Job {job_id} ({job_type}) cancelled")
            except Exception as exc:
                logger.exception(f"Job {job_id} ({job_type}) failed")
                self.store.update_job_status(job_id, "failed", error=str(exc))
            finally:
                self._tasks.pop(job_id, None)

        task = asyncio.create_task(_run())
        self._tasks[job_id] = task
        return job

    def cancel_all(self) -> None:
        """Cancel all running tasks (called at shutdown)."""
        for job_id, task in self._tasks.items():
            task.cancel()
            logger.info(f"Cancelled job {job_id}")
        self._tasks.clear()
