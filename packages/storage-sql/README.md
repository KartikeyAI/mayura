# @mayura/storage-sql

Shared Node.js SQL engine for Mayura's explicitly selected storage adapters. Development preview; not enterprise-qualified or published.

Applications normally install `@mayura/storage-sqlite` or `@mayura/storage-postgres`, not this implementation package directly. Both adapters use one implementation of aggregate validation, scheduled workflow reduction, lease/fencing semantics, completion facts and finite completion waits. This package has no SQL driver dependency.

The explicit `@mayura/storage-sql/host` entry exposes trusted adapter plumbing. It is not a tool API, sandbox, authentication boundary or replacement for an application's scoped authorization. No default root export or arbitrary source/dist deep imports are supported. Store interfaces and the identical `StorageError` constructor remain in `@mayura/storage-contracts`.

Package extraction does not change hashes, storage formats, table identities, state transitions or rollback/recovery semantics. Production scale, operating-system coverage and the complete enterprise release gates remain unqualified.
