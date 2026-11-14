// THE APP'S FILE STORAGE, BUILT ONCE FROM THE ENVIRONMENT (DISK BY DEFAULT)

// IMPORTED TYPES
import type { Storage } from './storage';
// IMPORTED ENVS
import {
	AFB_STORAGE_DIR,
	BETTER_AUTH_SECRET,
	S3_ACCESS_KEY_ID,
	S3_BUCKET,
	S3_ENDPOINT,
	S3_SECRET_ACCESS_KEY
} from '$app/env/private';
// IMPORTED MODULES
import { diskStorage, s3Storage } from './storage';

// -- STATES -- //

let storage: Storage | null = null;

// -- FUNCTIONS -- //

/** S3 compatible storage when it is configured, otherwise a folder on disk. A half configured S3 stops the app at start. */
export function getStorage(): Storage {
	if (storage) return storage;
	if (S3_ENDPOINT || S3_BUCKET || S3_ACCESS_KEY_ID || S3_SECRET_ACCESS_KEY) {
		if (!(S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY))
			throw new Error(
				'S3 storage needs S3_ENDPOINT, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY together'
			);
		storage = s3Storage({
			endpoint: S3_ENDPOINT,
			bucket: S3_BUCKET,
			accessKeyId: S3_ACCESS_KEY_ID,
			secretAccessKey: S3_SECRET_ACCESS_KEY
		});
	} else {
		storage = diskStorage(AFB_STORAGE_DIR ?? '.afb/files', BETTER_AUTH_SECRET);
	}
	return storage;
}
