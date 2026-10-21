import { index, route, type RouteConfig } from '@react-router/dev/routes';
export default [index('routes/home.tsx'), route('api/mayura/*', 'routes/api.ts')] satisfies RouteConfig;
