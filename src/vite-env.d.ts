/// <reference types="vite/client" />
declare module '*.sql?raw' {
  const sql: string;
  export default sql;
}
