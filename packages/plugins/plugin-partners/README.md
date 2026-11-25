# Partners

Paperclip plugin `partnersinbiz.partners`. A link stays pending until both companies accept. A grant names one CRM record or invoice. Accepting it asks CRM or billing to record that named share. The record is not copied.

Agent tools: `list-links` (`status`), `list-grants` (`direction`, `status`, `recordType`), `propose-link` (`otherCompanyId`), `propose-grant` (`linkId`, `recordType`, `recordId`, `granteeCompanyId`) and `revoke-grant` (`grantId`). A person at the owner company accepts links and grants on the Partners page. Proposing a revoked record again reopens that grant.

Access: every page action, agent tool and API route goes through the kit access guard, with a row in `src/access-table.ts` (`partners.grants`: `view` reads, `create` proposes, `edit` accepts, `delete` revokes; the skill sync is owner or admin only). With the company's access switch `off` the guard passes every call on unchanged. Page actions come from `src/ui/actions.ts`, so a refusal shows its message instead of reading as success.
