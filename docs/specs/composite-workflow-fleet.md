# Composite workflow fleet and host

Status: durable saga/loop parent discovery, finite continuation and explicit hosting implemented over the generic aggregate store.

`@mayura/workflows/composites` owns saga and loop runtimes plus a separate 256-shard active-parent index. Submission writes the parent first and then its index entry; retrying the same stable submission key repairs the narrow cross-aggregate crash window. Terminal parents are removed after their terminal state is observed. Unknown definition hashes remain indexed and are reported without dispatch.

`runPage` accepts explicit genuine saga and loop catalogs, validates scope-bound finite cursors and advances a bounded candidate page. Waiting composite parents are conservatively rechecked because a human response may complete their linked lifecycle child without changing the parent index first.

`createWorkflowCompositeHost` adds explicit-start, single-flight cycles, capped backoff, sanitized status and graceful drain. It starts no work during construction and never closes application-owned storage. Deployments still own leader election; only one active host should drive a scope unless an external lease elects the leader.
