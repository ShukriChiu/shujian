"""Background scheduler for daily Oura + CGM sync."""

from __future__ import annotations

import logging
from typing import Optional

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from health.config import get_settings

logger = logging.getLogger(__name__)

_scheduler: Optional[BackgroundScheduler] = None


def _run_daily_sync() -> None:
    from health import cgm, oura
    from health.tenants import seed_default_tenant

    seed_default_tenant()
    args = argparse_namespace(days=2, all_tenants=True)
    logger.info("Starting scheduled health sync for all enabled tenants")
    try:
        oura.cmd_sync(args)
    except Exception:
        logger.exception("Oura scheduled sync failed")

    try:
        cgm.cmd_sync(args)
    except Exception:
        logger.exception("CGM scheduled sync failed")


def argparse_namespace(**kwargs):
    class _NS:
        pass

    ns = _NS()
    for k, v in kwargs.items():
        setattr(ns, k, v)
    for name, default in (
        ("start", None),
        ("end", None),
        ("resource", None),
        ("resume", False),
        ("include_heartrate", False),
        ("owner", None),
        ("all_tenants", False),
        ("json", False),
    ):
        if not hasattr(ns, name):
            setattr(ns, name, default)
    return ns


def start_scheduler() -> BackgroundScheduler:
    global _scheduler
    if _scheduler is not None:
        return _scheduler

    settings = get_settings()
    _scheduler = BackgroundScheduler(timezone="UTC")
    _scheduler.add_job(
        _run_daily_sync,
        CronTrigger(hour=settings.sync_cron_hour, minute=0),
        id="daily_health_sync",
        replace_existing=True,
    )
    _scheduler.start()
    logger.info("Health scheduler started (UTC hour=%s)", settings.sync_cron_hour)
    return _scheduler


def shutdown_scheduler() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
