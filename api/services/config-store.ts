import fs from 'fs';
import path from 'path';
import type { WorldConfig } from '../../shared/types.js';

const CONFIG_DIR = path.join(process.cwd(), 'data');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const DEFAULT_CONFIG: WorldConfig = {
  worldSetting: `## 斗破苍穹 · 迦南学院
斗气大陆，一个以斗气修炼为核心的世界。强者为尊，弱肉强食。
迦南学院是大陆上最负盛名的学府之一，坐落于加玛帝国边境，汇聚各国天才。
学院深处封印着"陨落心炎"——一种天地异火，时刻散发着炙热的气息。
此时正值学院内院选拔前夕，各方势力暗流涌动。天才云集的内院，每一个人都有不为人知的秘密与野心。`,
  characters: [
    {
      id: 'xiao-yan',
      name: '萧炎',
      persona: '（性别：男性）天才少年，曾经的家族荣耀沦为废物三年，后得药老相助恢复实力。性格坚韧不服输，嘴上带着几分痞气和自信，骨子里重情重义。目前实力斗师巅峰，体内蕴含异火"青莲地心火"。说话直接，偶尔带点调侃。',
    },
    {
      id: 'xun-er',
      name: '薰儿',
      persona: '（性别：女性）古族血脉，迦南学院第一天才，温婉大方但实力深不可测。对萧炎有深厚感情，总是默默守护在旁。说话温柔但不失坚定，面对敌人时会展现出强大气场。擅长金色斗气，实力远超同龄人。',
    },
    {
      id: 'lin-xiu-ya',
      name: '林修崖',
      persona: '（性别：男性）迦南学院内院排名前列的强者，风属性斗气修炼者。外表温文尔雅、风度翩翩，实则心思缜密，城府颇深。对薰儿有爱慕之心，视萧炎为情敌。说话彬彬有礼但暗含锋芒。',
    },
    {
      id: 'zi-yan',
      name: '紫妍',
      persona: '（性别：女性）神秘少女，外表看似七八岁小女孩，实则为远古龙凤兽化形，实力恐怖。性格任性霸道、贪吃好斗，最喜欢缠着萧炎要丹药吃。说话直来直去，经常用拳头解决问题。口头禅是"不给就揍你"。',
    },
    {
      id: 'yao-lao',
      name: '药老',
      persona: '（性别：男性）药尘，曾经的大陆巅峰强者、丹药宗师，现以灵魂状态寄居在萧炎的戒指中。说话老成持重，偶尔会以长辈口吻调侃萧炎。见多识广，对各种奇珍异宝和势力了如指掌。喜欢在关键时刻给出点拨。',
    },
  ],
};

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadConfigFromFile(): WorldConfig | null {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as WorldConfig;
  } catch (e) {
    console.error('[配置] 读取配置文件失败，使用默认配置:', e);
    return null;
  }
}

function saveConfigToFile(cfg: WorldConfig) {
  try {
    ensureConfigDir();
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
  } catch (e) {
    console.error('[配置] 写入配置文件失败:', e);
  }
}

// 初始化：优先从文件加载，不存在则写入默认值
function initConfig(): WorldConfig {
  const fromFile = loadConfigFromFile();
  if (fromFile) {
    console.log('[配置] 从 data/config.json 加载配置，并迁移为文字聊天室配置');
    const migrated: WorldConfig = {
      worldSetting: fromFile.worldSetting || DEFAULT_CONFIG.worldSetting,
      characters: Array.isArray(fromFile.characters) ? fromFile.characters : DEFAULT_CONFIG.characters,
      builderPrompts: fromFile.builderPrompts,
    };
    saveConfigToFile(migrated);
    return migrated;
  }
  console.log('[配置] 使用默认配置并写入 data/config.json');
  saveConfigToFile(DEFAULT_CONFIG);
  return { ...DEFAULT_CONFIG };
}

let config: WorldConfig = initConfig();

export function getConfig(): WorldConfig {
  return {
    worldSetting: config.worldSetting,
    characters: [...config.characters],
    builderPrompts: config.builderPrompts,
  };
}

export function updateConfig(newConfig: WorldConfig): WorldConfig {
  config = {
    worldSetting: newConfig.worldSetting,
    characters: newConfig.characters.map((character) => ({
      id: character.id,
      name: character.name,
      persona: character.persona,
    })),
    builderPrompts: newConfig.builderPrompts ?? config.builderPrompts,
  };
  saveConfigToFile(config);
  return getConfig();
}
