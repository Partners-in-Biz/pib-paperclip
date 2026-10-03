-- 0.14.0: the client project. Every issue of a client sprint (root issue and tasks) opens in the
-- client's own Paperclip project, whatever the site access mode. Empty means the company SEO project.
ALTER TABLE plugin_seo_8099f8879a.sprints ADD COLUMN client_project_id text;
