'use strict';

const winston = require('winston');

const db = require('../database');
const utils = require('../utils');

const activitypub = module.parent.exports;

const Actors = module.exports;

Actors.assert = async (ids, options = {}) => {
	// Handle single values
	if (!Array.isArray(ids)) {
		ids = [ids];
	}

	// Filter out uids if passed in
	ids = ids.filter(id => !utils.isNumber(id));

	// Filter out existing
	if (!options.update) {
		const exists = await db.isSortedSetMembers('usersRemote:lastCrawled', ids.map(id => ((typeof id === 'object' && id.hasOwnProperty('id')) ? id.id : id)));
		ids = ids.filter((id, idx) => !exists[idx]);
	}

	if (!ids.length) {
		return true;
	}

	winston.verbose(`[activitypub/actors] Asserting ${ids.length} actor(s)`);

	const followersUrlMap = new Map();
	const pubKeysMap = new Map();
	const actors = await Promise.all(ids.map(async (id) => {
		try {
			winston.verbose(`[activitypub/actors] Processing ${id}`);
			const actor = (typeof id === 'object' && id.hasOwnProperty('id')) ? id : await activitypub.get('uid', 0, id);

			// Follow counts
			try {
				const [followers, following] = await Promise.all([
					actor.followers ? activitypub.get('uid', 0, actor.followers) : { totalItems: 0 },
					actor.following ? activitypub.get('uid', 0, actor.following) : { totalItems: 0 },
				]);
				actor.followerCount = followers.totalItems;
				actor.followingCount = following.totalItems;
			} catch (e) {
				// no action required
				winston.verbose(`[activitypub/actor.assert] Unable to retrieve follower counts for ${actor.id}`);
			}

			// Post count
			const outbox = actor.outbox ? await activitypub.get('uid', 0, actor.outbox) : { totalItems: 0 };
			actor.postcount = outbox.totalItems;

			// Followers url for backreference
			if (actor.hasOwnProperty('followers') && activitypub.helpers.isUri(actor.followers)) {
				followersUrlMap.set(actor.followers, actor.id);
			}

			// Public keys
			pubKeysMap.set(actor.id, actor.publicKey);

			return actor;
		} catch (e) {
			return null;
		}
	}));

	// Build userData object for storage
	const profiles = await activitypub.mocks.profile(actors);
	const now = Date.now();

	const bulkSet = profiles.reduce((memo, profile) => {
		if (profile) {
			const key = `userRemote:${profile.uid}`;
			memo.push([key, profile], [`${key}:keys`, pubKeysMap.get(profile.uid)]);
		}

		return memo;
	}, []);
	if (followersUrlMap.size) {
		bulkSet.push(['followersUrl:uid', Object.fromEntries(followersUrlMap)]);
	}

	await Promise.all([
		db.setObjectBulk(bulkSet),
		db.sortedSetAdd('usersRemote:lastCrawled', ids.map((id, idx) => (profiles[idx] ? now : null)).filter(Boolean), ids.filter((id, idx) => profiles[idx])),
	]);

	return actors.every(Boolean);
};
