import { db } from '../db.ts';
import { unwrap } from '../result.ts';

/** Email addresses of everyone on the admins list, for notifications. */
export async function adminEmails(): Promise<string[]> {
  const rows = unwrap(await db().from('admins').select('user_id'), 'supabase', 'listing admins') as Array<{
    user_id: string;
  }>;
  const emails: string[] = [];
  for (const { user_id } of rows) {
    const { data, error } = await db().auth.admin.getUserById(user_id);
    if (error) {
      console.error(`[admins] couldn't read admin ${user_id}: ${error.message}`);
      continue;
    }
    if (data.user?.email) emails.push(data.user.email);
  }
  return emails;
}
