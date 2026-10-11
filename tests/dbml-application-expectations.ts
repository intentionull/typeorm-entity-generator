import type {
  Column,
  ColumnDefault,
  ForeignKey,
  Key,
  ReferentialAction,
  Table,
} from '../src/schema/model.js';
import type { Facts, SchemaFacts } from './dbml-test-helpers.js';

// Handwritten catalog facts. These helpers only construct contract objects; they parse no source.
function c(
  name: string,
  type: string,
  nullable = false,
  modifiers: number[] = [],
  defaultValue?: ColumnDefault,
): Facts<Column> {
  return {
    name,
    type: { kind: 'builtin', schema: 'pg_catalog', name: type, modifiers },
    nullable,
    ...(defaultValue ? { default: defaultValue } : {}),
  };
}
function e(name: string, schema: string, type: string, value: string): Facts<Column> {
  return {
    name,
    type: { kind: 'enum', schema, name: type, modifiers: [] },
    nullable: false,
    default: { kind: 'literal', type: 'string', value },
  };
}
function k(columns: string[], name?: string): Facts<Key> {
  return { columns, ...(name ? { name } : {}) };
}
function f(
  name: string,
  columns: string[],
  target: [string, string],
  targetColumns = ['id'],
  onDelete: ReferentialAction = 'no action',
  onUpdate: ReferentialAction = 'no action',
): Facts<ForeignKey> {
  return {
    name,
    columns,
    target: { schema: target[0], name: target[1] },
    targetColumns,
    onDelete,
    onUpdate,
    match: 'simple',
    deferrable: false,
    initiallyDeferred: false,
  };
}
function t(
  schema: string,
  name: string,
  columns: Facts<Column>[],
  primaryKey: Facts<Key>,
  extras: Partial<Pick<Facts<Table>, 'uniqueKeys' | 'foreignKeys' | 'indexes'>> = {},
): Facts<Table> {
  return {
    schema,
    name,
    columns,
    primaryKey,
    uniqueKeys: [],
    foreignKeys: [],
    indexes: [],
    ...extras,
  };
}
const zero: ColumnDefault = { kind: 'literal', type: 'number', value: '0' };
const one: ColumnDefault = { kind: 'literal', type: 'number', value: '1' };
const yes: ColumnDefault = { kind: 'literal', type: 'boolean', value: true };
const no: ColumnDefault = { kind: 'literal', type: 'boolean', value: false };
const now: ColumnDefault = { kind: 'expression', sql: 'now()' };
const string = (value: string): ColumnDefault => ({ kind: 'literal', type: 'string', value });

export const applications: Record<string, SchemaFacts> = {
  commerce: {
    version: 1,
    dialect: 'postgres',
    namespaces: ['public', 'shop'],
    enums: [
      { schema: 'shop', name: 'order_state', values: ['draft', 'placed', 'shipped', 'cancelled'] },
    ],
    tables: [
      t(
        'shop',
        'customers',
        [
          c('id', 'uuid'),
          c('email', 'varchar', false, [254]),
          c('name', 'text'),
          c('active', 'bool', false, [], yes),
          c('created_at', 'timestamptz', false, [], now),
        ],
        k(['id']),
        { uniqueKeys: [k(['email'])] },
      ),
      t(
        'shop',
        'addresses',
        [
          c('id', 'uuid'),
          c('customer_id', 'uuid'),
          c('street', 'text'),
          c('postcode', 'varchar', false, [16]),
          c('country', 'bpchar', false, [2], string('US')),
        ],
        k(['id']),
        {
          foreignKeys: [
            f('address_customer', ['customer_id'], ['shop', 'customers'], ['id'], 'cascade'),
          ],
        },
      ),
      t(
        'shop',
        'products',
        [
          c('id', 'uuid'),
          c('sku', 'varchar', false, [40]),
          c('title', 'text'),
          c('price', 'numeric', false, [12, 2], zero),
          c('attributes', 'jsonb', true, [], string('{}')),
        ],
        k(['id']),
        { uniqueKeys: [k(['sku'])] },
      ),
      t(
        'shop',
        'orders',
        [
          c('id', 'uuid'),
          c('customer_id', 'uuid'),
          c('address_id', 'uuid', true),
          e('state', 'shop', 'order_state', 'draft'),
          c('total', 'numeric', false, [18, 2], zero),
          c('created_at', 'timestamptz', false, [3], now),
        ],
        k(['id']),
        {
          indexes: [
            {
              name: 'orders_customer_time',
              columns: ['customer_id', 'created_at'],
              unique: false,
              method: 'btree',
            },
          ],
          foreignKeys: [
            f('order_customer', ['customer_id'], ['shop', 'customers'], ['id'], 'restrict'),
            f('order_address', ['address_id'], ['shop', 'addresses'], ['id'], 'set null'),
          ],
        },
      ),
      t(
        'shop',
        'order_items',
        [
          c('order_id', 'uuid'),
          c('product_id', 'uuid'),
          c('line_no', 'int4'),
          c('quantity', 'int4', false, [], one),
          c('unit_price', 'numeric', false, [12, 2]),
        ],
        k(['order_id', 'line_no'], 'order_items_pk'),
        {
          uniqueKeys: [k(['order_id', 'product_id'], 'order_items_product_key')],
          foreignKeys: [
            f('item_order', ['order_id'], ['shop', 'orders'], ['id'], 'cascade'),
            f('item_product', ['product_id'], ['shop', 'products'], ['id'], 'restrict'),
          ],
        },
      ),
      t(
        'shop',
        'payment_records',
        [
          c('id', 'uuid'),
          c('order_id', 'uuid'),
          c('reference', 'varchar', false, [64]),
          c('amount', 'numeric', false, [18, 2]),
        ],
        k(['id']),
        {
          uniqueKeys: [k(['reference'])],
          foreignKeys: [f('payment_order', ['order_id'], ['shop', 'orders'], ['id'], 'restrict')],
        },
      ),
      t(
        'shop',
        'shipments',
        [
          c('id', 'uuid'),
          c('order_id', 'uuid'),
          c('shipped_at', 'timestamptz', true),
          c('tracking', 'varchar', true, [80]),
        ],
        k(['id']),
        {
          uniqueKeys: [k(['order_id'])],
          foreignKeys: [f('shipment_order', ['order_id'], ['shop', 'orders'], ['id'], 'cascade')],
        },
      ),
    ],
  },
  tenancy: {
    version: 1,
    dialect: 'postgres',
    namespaces: ['public', 'tenant'],
    enums: [
      { schema: 'tenant', name: 'membership_state', values: ['active', 'invited', 'disabled'] },
    ],
    tables: [
      t('tenant', 'tenants', [c('id', 'uuid'), c('slug', 'varchar', false, [64])], k(['id']), {
        uniqueKeys: [k(['slug'])],
      }),
      t('tenant', 'users', [c('id', 'uuid'), c('email', 'varchar', false, [254])], k(['id']), {
        uniqueKeys: [k(['email'])],
      }),
      t(
        'tenant',
        'memberships',
        [
          c('tenant_id', 'uuid'),
          c('user_id', 'uuid'),
          e('state', 'tenant', 'membership_state', 'invited'),
        ],
        k(['tenant_id', 'user_id']),
        {
          foreignKeys: [
            f('membership_tenant', ['tenant_id'], ['tenant', 'tenants'], ['id'], 'cascade'),
            f('membership_user', ['user_id'], ['tenant', 'users'], ['id'], 'cascade'),
          ],
        },
      ),
      t(
        'tenant',
        'projects',
        [
          c('tenant_id', 'uuid'),
          c('id', 'uuid'),
          c('owner_id', 'uuid', true),
          c('name', 'text'),
          c('code', 'varchar', false, [32]),
        ],
        k(['tenant_id', 'id']),
        {
          uniqueKeys: [k(['tenant_id', 'code'], 'projects_tenant_code')],
          foreignKeys: [
            f('project_tenant', ['tenant_id'], ['tenant', 'tenants'], ['id'], 'cascade'),
            f(
              'project_owner',
              ['tenant_id', 'owner_id'],
              ['tenant', 'memberships'],
              ['tenant_id', 'user_id'],
            ),
          ],
        },
      ),
      t(
        'tenant',
        'tasks',
        [
          c('tenant_id', 'uuid'),
          c('id', 'uuid'),
          c('project_id', 'uuid'),
          c('assignee_id', 'uuid', true),
          c('title', 'text'),
          c('done', 'bool', false, [], no),
        ],
        k(['tenant_id', 'id']),
        {
          indexes: [
            {
              name: 'tasks_project',
              columns: ['tenant_id', 'project_id'],
              unique: false,
              method: 'btree',
            },
          ],
          foreignKeys: [
            f(
              'task_project',
              ['tenant_id', 'project_id'],
              ['tenant', 'projects'],
              ['tenant_id', 'id'],
              'cascade',
            ),
            f(
              'task_assignee',
              ['tenant_id', 'assignee_id'],
              ['tenant', 'memberships'],
              ['tenant_id', 'user_id'],
            ),
          ],
        },
      ),
      t(
        'tenant',
        'comments',
        [
          c('tenant_id', 'uuid'),
          c('id', 'uuid'),
          c('task_id', 'uuid'),
          c('author_id', 'uuid'),
          c('body', 'text'),
        ],
        k(['tenant_id', 'id']),
        {
          foreignKeys: [
            f(
              'comment_task',
              ['tenant_id', 'task_id'],
              ['tenant', 'tasks'],
              ['tenant_id', 'id'],
              'cascade',
            ),
            f(
              'comment_author',
              ['tenant_id', 'author_id'],
              ['tenant', 'memberships'],
              ['tenant_id', 'user_id'],
            ),
          ],
        },
      ),
    ],
  },
  permissions: {
    version: 1,
    dialect: 'postgres',
    namespaces: ['public', 'auth'],
    enums: [],
    tables: [
      t(
        'auth',
        'users',
        [c('id', 'uuid'), c('username', 'varchar', false, [64]), c('manager_id', 'uuid', true)],
        k(['id']),
        {
          uniqueKeys: [k(['username'])],
          foreignKeys: [f('user_manager', ['manager_id'], ['auth', 'users'], ['id'], 'set null')],
        },
      ),
      t('auth', 'roles', [c('id', 'int4'), c('code', 'varchar', false, [32])], k(['id']), {
        uniqueKeys: [k(['code'])],
      }),
      t('auth', 'permissions', [c('id', 'int4'), c('code', 'varchar', false, [80])], k(['id']), {
        uniqueKeys: [k(['code'])],
      }),
      t(
        'auth',
        'user_roles',
        [c('user_id', 'uuid'), c('role_id', 'int4'), c('granted_at', 'timestamp', false, [], now)],
        k(['user_id', 'role_id']),
        {
          foreignKeys: [
            f('user_role_user', ['user_id'], ['auth', 'users'], ['id'], 'cascade'),
            f('user_role_role', ['role_id'], ['auth', 'roles'], ['id'], 'cascade'),
          ],
        },
      ),
      t(
        'auth',
        'role_permissions',
        [c('role_id', 'int4'), c('permission_id', 'int4')],
        k(['role_id', 'permission_id']),
        {
          foreignKeys: [
            f('role_permission_role', ['role_id'], ['auth', 'roles'], ['id'], 'cascade'),
            f(
              'role_permission_permission',
              ['permission_id'],
              ['auth', 'permissions'],
              ['id'],
              'cascade',
            ),
          ],
        },
      ),
      t(
        'auth',
        'groups',
        [c('id', 'uuid'), c('parent_id', 'uuid', true), c('name', 'text')],
        k(['id']),
        {
          foreignKeys: [f('group_parent', ['parent_id'], ['auth', 'groups'], ['id'], 'set null')],
        },
      ),
      t(
        'auth',
        'group_members',
        [c('group_id', 'uuid'), c('user_id', 'uuid')],
        k(['group_id', 'user_id']),
        {
          foreignKeys: [
            f('group_member_group', ['group_id'], ['auth', 'groups'], ['id'], 'cascade'),
            f('group_member_user', ['user_id'], ['auth', 'users'], ['id'], 'cascade'),
          ],
        },
      ),
    ],
  },
  content: {
    version: 1,
    dialect: 'postgres',
    namespaces: ['public', 'identity', 'content'],
    enums: [
      { schema: 'content', name: 'publication_state', values: ['draft', 'published', 'archived'] },
    ],
    tables: [
      t('identity', 'accounts', [c('id', 'uuid'), c('handle', 'varchar', false, [64])], k(['id']), {
        uniqueKeys: [k(['handle'])],
      }),
      t(
        'content',
        'authors',
        [c('id', 'uuid'), c('account_id', 'uuid'), c('display_name', 'text')],
        k(['id']),
        {
          uniqueKeys: [k(['account_id'])],
          foreignKeys: [
            f('author_account', ['account_id'], ['identity', 'accounts'], ['id'], 'cascade'),
          ],
        },
      ),
      t(
        'content',
        'posts',
        [
          c('id', 'uuid'),
          c('author_id', 'uuid'),
          c('featured_revision_id', 'uuid', true),
          c('slug', 'varchar', false, [120]),
          e('state', 'content', 'publication_state', 'draft'),
          c('body', 'text', true),
        ],
        k(['id']),
        {
          uniqueKeys: [k(['slug'])],
          foreignKeys: [
            f('post_author', ['author_id'], ['content', 'authors'], ['id'], 'restrict'),
            f(
              'post_featured_revision',
              ['featured_revision_id'],
              ['content', 'revisions'],
              ['id'],
              'set null',
            ),
          ],
        },
      ),
      t(
        'content',
        'revisions',
        [
          c('id', 'uuid'),
          c('post_id', 'uuid'),
          c('editor_id', 'uuid'),
          c('body', 'text'),
          c('created_at', 'timestamp', false, [6], now),
        ],
        k(['id']),
        {
          foreignKeys: [
            f('revision_post', ['post_id'], ['content', 'posts'], ['id'], 'cascade'),
            f('revision_editor', ['editor_id'], ['content', 'authors'], ['id'], 'restrict'),
          ],
        },
      ),
      t('content', 'tags', [c('id', 'int4'), c('name', 'varchar', false, [40])], k(['id']), {
        uniqueKeys: [k(['name'])],
      }),
      t(
        'content',
        'post_tags',
        [c('post_id', 'uuid'), c('tag_id', 'int4')],
        k(['post_id', 'tag_id']),
        {
          foreignKeys: [
            f('post_tag_post', ['post_id'], ['content', 'posts'], ['id'], 'cascade'),
            f('post_tag_tag', ['tag_id'], ['content', 'tags'], ['id'], 'cascade'),
          ],
        },
      ),
      t(
        'content',
        'comments',
        [
          c('id', 'uuid'),
          c('post_id', 'uuid'),
          c('author_id', 'uuid', true),
          c('parent_id', 'uuid', true),
          c('body', 'text'),
        ],
        k(['id']),
        {
          foreignKeys: [
            f('comment_post', ['post_id'], ['content', 'posts'], ['id'], 'cascade'),
            f('comment_author', ['author_id'], ['content', 'authors'], ['id'], 'set null'),
            f('comment_parent', ['parent_id'], ['content', 'comments'], ['id'], 'set null'),
          ],
        },
      ),
    ],
  },
  scheduling: {
    version: 1,
    dialect: 'postgres',
    namespaces: ['public', 'calendar'],
    enums: [
      { schema: 'calendar', name: 'attendance_state', values: ['pending', 'accepted', 'declined'] },
    ],
    tables: [
      t(
        'calendar',
        'resources',
        [c('id', 'uuid'), c('name', 'text'), c('time_zone', 'varchar', false, [64], string('UTC'))],
        k(['id']),
      ),
      t(
        'calendar',
        'attendees',
        [c('id', 'uuid'), c('email', 'varchar', false, [254])],
        k(['id']),
        { uniqueKeys: [k(['email'])] },
      ),
      t(
        'calendar',
        'calendars',
        [c('id', 'uuid'), c('owner_id', 'uuid'), c('name', 'text')],
        k(['id']),
        {
          foreignKeys: [
            f('calendar_owner', ['owner_id'], ['calendar', 'attendees'], ['id'], 'restrict'),
          ],
        },
      ),
      t(
        'calendar',
        'events',
        [
          c('id', 'uuid'),
          c('calendar_id', 'uuid'),
          c('resource_id', 'uuid', true),
          c('title', 'text'),
          c('event_date', 'date'),
          c('start_time', 'time', false, [3]),
          c('offset_time', 'timetz', true, [6]),
          c('starts_at', 'timestamptz', false, [6]),
          c('duration_minutes', 'int2', false, [], {
            kind: 'literal',
            type: 'number',
            value: '30',
          }),
          c('previous_event_id', 'uuid', true),
        ],
        k(['id']),
        {
          foreignKeys: [
            f('event_calendar', ['calendar_id'], ['calendar', 'calendars'], ['id'], 'cascade'),
            f('event_resource', ['resource_id'], ['calendar', 'resources'], ['id'], 'set null'),
            f('event_previous', ['previous_event_id'], ['calendar', 'events'], ['id'], 'set null'),
          ],
        },
      ),
      t(
        'calendar',
        'reservations',
        [c('resource_id', 'uuid'), c('event_id', 'uuid'), c('slot', 'int4')],
        k(['resource_id', 'event_id', 'slot']),
        {
          uniqueKeys: [k(['event_id', 'slot'], 'reservation_event_slot')],
          foreignKeys: [
            f(
              'reservation_resource',
              ['resource_id'],
              ['calendar', 'resources'],
              ['id'],
              'cascade',
            ),
            f('reservation_event', ['event_id'], ['calendar', 'events'], ['id'], 'cascade'),
          ],
        },
      ),
      t(
        'calendar',
        'event_attendees',
        [
          c('event_id', 'uuid'),
          c('attendee_id', 'uuid'),
          e('state', 'calendar', 'attendance_state', 'pending'),
        ],
        k(['event_id', 'attendee_id']),
        {
          foreignKeys: [
            f('attendance_event', ['event_id'], ['calendar', 'events'], ['id'], 'cascade'),
            f('attendance_attendee', ['attendee_id'], ['calendar', 'attendees'], ['id'], 'cascade'),
          ],
        },
      ),
      t(
        'calendar',
        'reminders',
        [
          c('id', 'uuid'),
          c('event_id', 'uuid'),
          c('attendee_id', 'uuid', true),
          c('delivery_at', 'timestamptz', false, [6]),
          c('sent', 'bool', false, [], no),
          c('payload', 'bytea', true),
        ],
        k(['id']),
        {
          foreignKeys: [
            f('reminder_event', ['event_id'], ['calendar', 'events'], ['id'], 'cascade'),
            f('reminder_attendee', ['attendee_id'], ['calendar', 'attendees'], ['id'], 'set null'),
          ],
        },
      ),
    ],
  },
};
