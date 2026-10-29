import { frontmatterSchema } from 'fumadocs-mdx/config';
import { z } from 'zod';

export const articleSchema = frontmatterSchema.extend({
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  date: z.iso.date(),
  author: z.string().trim().min(1).optional(),
  draft: z.boolean().default(false),
});
