# @mayura/client-react

Optional React 18.3/19 hooks over `@mayura/client/headless`. The package exposes `useMayuraRun`, `useMayuraRunActions`, `useMayuraHumanRequest` and `useMayuraRunActivity`.

The caller owns and disposes the headless store. Hooks never refresh, observe, reconnect, cancel or create timers automatically. Call actions from explicit event/effect policy in the application. One shared store means multiple React consumers reuse the same bounded state and transport observation.

React is a peer dependency. Public Mayura declarations expose only Mayura types, so the framework does not install or export a second React type universe.
