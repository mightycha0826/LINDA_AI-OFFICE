// Discord 서버 권한 점검. 토큰은 로컬 비밀 파일에서만 읽고 출력하지 않는다.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PermissionsBitField, REST, Routes } from 'discord.js';
import { loadChiefDiscordToken } from '../packages/orchestrator/src/discord/chief-authority.ts';

const data = process.env.AI_OFFICE_DATA || 'C:\\ai-office\\data';
const config = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
const token = JSON.parse(readFileSync(join(data, 'secrets.json'), 'utf8')).discordToken;
if (!token) throw new Error('시스템 봇 토큰이 설정되어 있지 않아요.');
const rest = new REST({ version: '10' }).setToken(token);
const guildId = config.discord.guildId;
const permissions = (bits) => new PermissionsBitField(BigInt(bits)).toArray();

try {
  const me = await rest.get(Routes.user('@me'));
  const roles = await rest.get(Routes.guildRoles(guildId));
  const chiefRole = roles.find((r) => r.name.startsWith('백서진') && r.tags?.bot_id);
  const selected = [me.id, chiefRole?.tags.bot_id].filter(Boolean);
  const members = [];
  for (const id of selected) {
    const member = await rest.get(Routes.guildMember(guildId, id));
    const assigned = roles.filter((r) => member.roles.includes(r.id) || r.id === guildId);
    const bits = assigned.reduce((all, role) => all | BigInt(role.permissions), 0n);
    members.push({ id, name: member.user.username, roles: assigned.map((r) => ({ id: r.id, name: r.name, position: r.position, managed: r.managed, permissions: r.permissions, allowed: permissions(r.permissions) })), administrator: !!(bits & 8n), allowed: permissions(bits) });
  }
  const channels = await rest.get(Routes.guildChannels(guildId));
  const audit = { at: new Date().toISOString(), guildId, members, roles: roles.map((r) => ({ id: r.id, name: r.name, position: r.position, managed: r.managed, permissions: r.permissions, tags: r.tags })), overwrites: channels.filter((ch) => ch.permission_overwrites?.length).map((ch) => ({ id: ch.id, name: ch.name, overwrites: ch.permission_overwrites })) };
  const backup = join(data, 'discord-authority-before.json');
  if (!existsSync(backup)) writeFileSync(backup, JSON.stringify(audit, null, 2));
  writeFileSync(join(data, 'discord-authority-latest.json'), JSON.stringify(audit, null, 2));
  const chiefToken = loadChiefDiscordToken(config.hermes.homeDir);
  let chiefIdentity = null;
  if (chiefToken) {
    const manager = new REST({ version: '10' }).setToken(chiefToken);
    chiefIdentity = await manager.get(Routes.user('@me'));
    if (!chiefRole || chiefIdentity.id !== chiefRole.tags.bot_id) throw new Error('비서실장 인증과 서버 역할의 계정이 일치하지 않아요.');
    if (process.argv.includes('--apply')) {
      const chief = members.find((m) => m.id === chiefIdentity.id);
      const linda = members.find((m) => m.id === me.id);
      const highest = chief.roles.slice().sort((a, b) => b.position - a.position || (BigInt(a.id) < BigInt(b.id) ? -1 : 1))[0];
      const lindaRole = roles.find((r) => r.tags?.bot_id === me.id);
      if (!chief.administrator) throw new Error('백서진의 관리자 권한을 먼저 확인해 주세요.');
      if (!lindaRole || highest.position <= lindaRole.position) {
        console.log(JSON.stringify({ status: 'needs-owner-role-order', message: '서버 설정 → 역할에서 백서진(비서실장)을 LINDA보다 위로 올려 주세요. 현재 봇 계정은 자기보다 위에 있는 역할을 바꿀 수 없어요.', chiefRole: chiefRole.id, lindaRole: lindaRole?.id, channelManagementIdentity: chiefIdentity.username }));
        process.exitCode = 2;
      } else {
        const keep = new PermissionsBitField(['ViewChannel', 'SendMessages', 'EmbedLinks', 'AttachFiles', 'ReadMessageHistory', 'CreatePublicThreads', 'SendMessagesInThreads']);
        await manager.patch(Routes.guildRole(guildId, lindaRole.id), { body: { permissions: keep.bitfield.toString() }, reason: 'CEO 요청: LINDA는 시스템 안내만, 관리 권한은 비서실장 백서진에게 이관' });
        const updated = await manager.get(Routes.guildRoles(guildId));
        const reduced = updated.find((r) => r.id === lindaRole.id);
        if (BigInt(reduced.permissions) !== keep.bitfield) throw new Error('LINDA의 역할 권한 변경을 확인하지 못했어요.');
        console.log(JSON.stringify({ status: 'applied', lindaRole: reduced.id, permissions: reduced.permissions, allowed: permissions(reduced.permissions), chief: chiefIdentity.username, inheritedFromEveryone: linda.roles.find((r) => r.id === guildId)?.allowed }));
      }
    }
  } else if (process.argv.includes('--apply')) throw new Error('Hermes의 비서실장 봇 인증을 찾지 못했어요.');
  if (!process.argv.includes('--apply')) console.log(JSON.stringify({ guildId, members, chiefIdentity: chiefIdentity?.username, chiefChannelsReady: !!chiefIdentity, roleOrder: audit.roles.sort((a, b) => b.position - a.position), channelOverrides: audit.overwrites.length }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: error.status, code: error.code, message: error.message }));
  process.exitCode = 1;
}
