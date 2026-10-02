-- Migration 008: Document execution, proxy, browser_spawning, and advanced_runtime columns as seed templates only
-- Finding 7: Architecture Boundary Clarification
-- Local ACP owns runtime browser execution, proxy orchestration, and hardware-bound execution configs in SQLite.
-- The PostgreSQL columns below serve strictly as default initial bootstrap presets for new client instances.
-- They must not be treated as authoritative runtime control boundaries by the Cloud Backend.

COMMENT ON COLUMN global_automation_configs.proxy IS 'DEPRECATED FOR RUNTIME: Default seed preset for proxy orchestration. Authoritative runtime ownership belongs to Control Plane local SQLite.';
COMMENT ON COLUMN global_automation_configs.execution IS 'DEPRECATED FOR RUNTIME: Default seed preset for execution rules. Authoritative runtime ownership belongs to Control Plane local SQLite.';
COMMENT ON COLUMN global_automation_configs.browser_spawning IS 'DEPRECATED FOR RUNTIME: Default seed preset for browser spawning. Authoritative runtime ownership belongs to Control Plane local SQLite.';
COMMENT ON COLUMN global_automation_configs.advanced_runtime IS 'DEPRECATED FOR RUNTIME: Default seed preset for advanced runtime settings. Authoritative runtime ownership belongs to Control Plane local SQLite.';
