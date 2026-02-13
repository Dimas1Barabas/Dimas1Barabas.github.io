import { defineConfig } from '@prisma/config'

export default defineConfig({
  datasource: {
    url: process.env.PRISMA_DATABASE_URL,
  },
})
