import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base: GitHub Pages = '/career/'(기본). Cloudflare Pages(루트 도메인)는 VITE_BASE='/' 주입.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? '/career/',
})
