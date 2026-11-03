// Shapes of the JSON the scripts read and write.

export interface TopicPost {
	id: number;
	post_number: number;
	username?: string;
	created_at?: string;
	cooked?: string;
	[field: string]: unknown;
}

export interface TopicStream {
	posts?: TopicPost[];
	stream?: number[];
}

export interface TopicTag {
	name: string;
}

export interface TopicDoc {
	id: number;
	title?: string;
	posts_count?: number;
	highest_post_number?: number;
	last_posted_at?: string;
	created_at?: string;
	category_id?: number;
	closed?: boolean;
	archived?: boolean;
	views?: number;
	tags?: TopicTag[];
	post_stream?: TopicStream;
	[field: string]: unknown;
}

export interface FeedTopic {
	id: number;
	title?: string;
	posts_count?: number;
	highest_post_number?: number;
	last_posted_at?: string;
	category_id?: number;
}

export interface FeedDoc {
	topics?: FeedTopic[];
	topic_list?: { topics?: FeedTopic[] };
}

export interface IdsDoc {
	id?: number;
	post_ids?: number[];
}

export interface IndexRow {
	id?: number;
	read_upto?: number;
	verdict?: string;
	note?: string;
}

export type NoteRow =
	| { t: "asked"; id: number; anchor: number; high: number }
	| { t: "missing"; id: number; pid: (string | number)[] };
