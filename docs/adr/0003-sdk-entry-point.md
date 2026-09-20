# ADR 0003: A small convenience SDK entry point

Status: accepted for development, 2026-09-20. Requirements F28, V19–V21.

Provide `@mayura/sdk` as a thin re-export of core contracts, typed tools and the ephemeral agent runtime. Consumers can start with one Mayura authoring import; advanced applications may still import individual packages. The facade does not create a second runtime, model gateway or authorization path.

It must depend only on core/tools/runtime. Storage, sandboxing, providers, servers, UI bindings and testing doubles remain deliberate separate imports. All names remain private registry placeholders pending owner confirmation. Packed consumer tests verify that definitions retain identity across facade/direct imports, negative TypeScript assertions still reject invalid inputs, and the facade introduces no external/native runtime dependency.

This is convenience, not an ambient configuration mechanism: the caller still chooses a model, schemas and explicit grants. Do not auto-install extensions, load secrets or enable tools merely because the facade is imported.
