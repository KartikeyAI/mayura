# @mayura/server

Experimental authenticated Fetch transport for Mayura's ephemeral runtime plus application-provided human-request and durable-workflow read/control adapters. Workflow controls are limited to exact cancellation and approval commands; their adapter owns durable idempotency. The package also includes opt-in content-free liveness, access-controlled bounded readiness checks and a paginated metadata-only tool catalog. No listener, database, environment credential discovery, durable worker service or production-hosting claim. See the repository's transport specifications.
