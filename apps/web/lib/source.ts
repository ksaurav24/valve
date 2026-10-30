import { loader } from 'fumadocs-core/source';
import { articles, changelog, contributing, docs } from '../.source/server';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
});

export const articlesSource = loader({
  baseUrl: '/articles',
  source: articles.toFumadocsSource(),
});

export const changelogSource = loader({
  baseUrl: '/changelog',
  source: changelog.toFumadocsSource(),
});

export const contributingSource = loader({
  baseUrl: '/contributors',
  source: contributing.toFumadocsSource(),
});
