import type { MetadataRoute } from 'next';

const SITE = 'http://localhost:3000';

const ROUTES: Array<{
  path: string;
  changeFrequency: MetadataRoute.Sitemap[number]['changeFrequency'];
  priority: number;
}> = [
  { path: '/', changeFrequency: 'weekly', priority: 1.0 },
  { path: '/docs', changeFrequency: 'weekly', priority: 0.9 },
  { path: '/docs/quickstart', changeFrequency: 'monthly', priority: 0.85 },
];

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  return ROUTES.map(({ path, changeFrequency, priority }) => ({
    url: `${SITE}${path}`,
    lastModified,
    changeFrequency,
    priority,
  }));
}
