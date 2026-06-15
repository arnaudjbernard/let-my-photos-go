import { getValidAccessToken } from './oauth.js';
import type { Config } from './config.js';

export interface MediaItem {
  id: string;
  filename: string;
  productUrl: string;
  baseUrl: string;
  mimeType: string;
  mediaMetadata: {
    creationTime: string;
    width: string;
    height: string;
    photo?: Record<string, unknown>;
    video?: Record<string, unknown>;
  };
}

interface MediaItemsResponse {
  mediaItems?: MediaItem[];
  nextPageToken?: string;
}

export async function* enumerateAllMediaItems(
  config: Config,
  onProgress?: (count: number) => void
): AsyncGenerator<MediaItem> {
  let pageToken: string | undefined;
  let totalFetched = 0;

  do {
    const token = await getValidAccessToken(config.clientId, config.clientSecret);

    const params = new URLSearchParams({ pageSize: '100' });
    if (pageToken) params.set('pageToken', pageToken);

    const response = await fetch(
      `https://photoslibrary.googleapis.com/v1/mediaItems?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Google Photos API error ${response.status}: ${body}`);
    }

    const data: MediaItemsResponse = await response.json();

    for (const item of data.mediaItems ?? []) {
      totalFetched++;
      onProgress?.(totalFetched);
      yield item;
    }

    pageToken = data.nextPageToken;
  } while (pageToken);
}
