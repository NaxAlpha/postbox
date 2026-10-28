export interface Domain {
  name: string;
  zoneId: string;
  sending: boolean;
  receiving: boolean;
  catchAll: boolean;
  addressCreation?: 'catch-all' | 'managed-route' | 'cli' | 'disabled';
}
export interface MailAddress {
  id: string;
  email: string;
  name: string;
  color: string;
  enabled: number;
  send_enabled: number;
  signature: string;
  unread?: number;
}
export type Folder = 'inbox' | 'archive' | 'sent' | 'draft' | 'spam' | 'trash';
export interface MailMessage {
  id: string;
  address_id: string;
  address_email?: string;
  address_color?: string;
  thread_id: string;
  folder: Folder;
  direction: 'inbound' | 'outbound';
  subject: string;
  from_address: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  snippet: string;
  received_at: string;
  is_read: number;
  starred: number;
  labels_json: string;
  size: number;
  reply_to_json: string;
  reply_id?: string;
  forward_id?: string;
  revision: number;
  rfc_id: string;
  provider_id: string;
  status: string;
  error: string;
  attachments?: Attachment[];
  text?: string;
  html?: string;
  truncated?: boolean;
  delivery?: { recipient: string; status: string; created_at: string }[];
}
export interface Attachment {
  id: string;
  message_id: string | null;
  address_id: string;
  filename: string;
  type: string;
  size: number;
  object_key: string;
  content_id: string;
  disposition: string;
}
export interface MailJob {
  kind: 'ingest' | 'send';
  id: string;
}
export interface Compose {
  id?: string;
  revision?: number;
  addressId: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  attachments: string[];
  replyToMessageId?: string;
  forwardMessageId?: string;
}
