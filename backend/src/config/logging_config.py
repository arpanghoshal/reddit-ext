"""
Centralized structured logging configuration.
Uses structlog for JSON output in production and colored console in development.
Context variables allow request_id, team_id, user_id to be automatically
injected into every log line.
"""

import os
import logging
import structlog
from contextvars import ContextVar

# Context variables for request-scoped data
request_id_var: ContextVar[str] = ContextVar("request_id", default="")
team_id_var: ContextVar[str] = ContextVar("team_id", default="")
user_id_var: ContextVar[str] = ContextVar("user_id", default="")


def inject_context(logger, method_name, event_dict):
    """Inject request context into every log line."""
    rid = request_id_var.get("")
    tid = team_id_var.get("")
    uid = user_id_var.get("")
    if rid:
        event_dict["request_id"] = rid
    if tid:
        event_dict["team_id"] = tid
    if uid:
        event_dict["user_id"] = uid
    return event_dict


def setup_logging():
    """Configure structured logging for the application."""
    is_production = os.getenv("ENVIRONMENT") == "production"
    log_level = os.getenv("LOG_LEVEL", "INFO").upper()

    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        inject_context,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.format_exc_info,
    ]

    if is_production:
        renderer = structlog.processors.JSONRenderer()
    else:
        renderer = structlog.dev.ConsoleRenderer()

    structlog.configure(
        processors=shared_processors
        + [
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        wrapper_class=structlog.stdlib.BoundLogger,
        cache_logger_on_first_use=True,
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            renderer,
        ],
    )

    handler = logging.StreamHandler()
    handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
    root_logger.setLevel(getattr(logging, log_level, logging.INFO))

    # Quiet down noisy third-party loggers
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    logging.getLogger("hpack").setLevel(logging.WARNING)


def get_logger(name: str):
    """Get a structured logger for the given module name."""
    return structlog.get_logger(name)
