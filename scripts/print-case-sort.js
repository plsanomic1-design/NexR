const CASES_DATA_BASE = [
    {
        id: 'starter',
        items: [
            { id: 'blue_gem', value: 30, chance: 55, rarity: 'common' },
            { id: 'gold_coin', value: 80, chance: 30, rarity: 'uncommon' },
            { id: 'crown', value: 200, chance: 12, rarity: 'rare' },
            { id: 'diamond', value: 500, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'standard',
        items: [
            { id: 'bronze_shield', value: 100, chance: 40, rarity: 'common' },
            { id: 'silver_sword', value: 250, chance: 30, rarity: 'uncommon' },
            { id: 'hoverboard', value: 700, chance: 20, rarity: 'rare' },
            { id: 'dominus', value: 1500, chance: 8, rarity: 'epic' },
            { id: 'headless', value: 3000, chance: 2, rarity: 'legendary' }
        ]
    },
    {
        id: 'elite',
        items: [
            { id: 'rare_aura', value: 500, chance: 35, rarity: 'uncommon' },
            { id: 'dragon_scale', value: 1200, chance: 30, rarity: 'rare' },
            { id: 'void_sword', value: 2500, chance: 20, rarity: 'epic' },
            { id: 'elite_crown', value: 5000, chance: 12, rarity: 'legendary' },
            { id: 'eternal_diamond', value: 10000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'lucky',
        items: [
            { id: 'nothing', value: 0, chance: 45, rarity: 'common' },
            { id: 'lucky_charm', value: 200, chance: 35, rarity: 'rare' },
            { id: 'golden_ticket', value: 750, chance: 20, rarity: 'legendary' }
        ]
    },
    {
        id: 'amethyst',
        items: [
            { id: 'amethyst_shard', value: 15, chance: 50, rarity: 'common' },
            { id: 'purple_band', value: 30, chance: 35, rarity: 'uncommon' },
            { id: 'amethyst_ring', value: 90, chance: 12, rarity: 'rare' },
            { id: 'amethyst_crown', value: 300, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'ruby',
        items: [
            { id: 'ruby_shard', value: 40, chance: 55, rarity: 'common' },
            { id: 'red_hood', value: 120, chance: 30, rarity: 'uncommon' },
            { id: 'ruby_sword', value: 350, chance: 12, rarity: 'rare' },
            { id: 'ruby_dragon', value: 1200, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'emerald',
        items: [
            { id: 'emerald_shard', value: 110, chance: 55, rarity: 'common' },
            { id: 'green_band', value: 320, chance: 30, rarity: 'uncommon' },
            { id: 'emerald_blade', value: 1000, chance: 12, rarity: 'rare' },
            { id: 'emerald_dominus', value: 3000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'sapphire',
        items: [
            { id: 'sapphire_shard', value: 250, chance: 50, rarity: 'common' },
            { id: 'blue_hood', value: 600, chance: 35, rarity: 'uncommon' },
            { id: 'sapphire_sword', value: 2000, chance: 12, rarity: 'rare' },
            { id: 'sapphire_dragon', value: 6000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'diamond',
        items: [
            { id: 'diamond_shard', value: 450, chance: 55, rarity: 'common' },
            { id: 'white_band', value: 1100, chance: 30, rarity: 'uncommon' },
            { id: 'diamond_blade', value: 3500, chance: 12, rarity: 'rare' },
            { id: 'diamond_dominus', value: 12000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'void',
        items: [
            { id: 'void_dust', value: 800, chance: 55, rarity: 'common' },
            { id: 'dark_hood', value: 2200, chance: 30, rarity: 'uncommon' },
            { id: 'void_scepter', value: 7000, chance: 12, rarity: 'rare' },
            { id: 'void_dragon', value: 20000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'galactic',
        items: [
            { id: 'star_dust', value: 1800, chance: 55, rarity: 'common' },
            { id: 'cosmic_band', value: 4800, chance: 30, rarity: 'uncommon' },
            { id: 'galactic_blade', value: 15000, chance: 12, rarity: 'rare' },
            { id: 'galactic_dominus', value: 45000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'inferno',
        items: [
            { id: 'ember', value: 3500, chance: 55, rarity: 'common' },
            { id: 'flame_hood', value: 8500, chance: 30, rarity: 'uncommon' },
            { id: 'inferno_sword', value: 28000, chance: 12, rarity: 'rare' },
            { id: 'inferno_dragon', value: 80000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'divine',
        items: [
            { id: 'holy_light', value: 7500, chance: 55, rarity: 'common' },
            { id: 'divine_band', value: 19000, chance: 30, rarity: 'uncommon' },
            { id: 'divine_blade', value: 60000, chance: 12, rarity: 'rare' },
            { id: 'divine_dominus', value: 180000, chance: 3, rarity: 'legendary' }
        ]
    },
    {
        id: 'supreme',
        items: [
            { id: 'pure_gold', value: 15000, chance: 55, rarity: 'common' },
            { id: 'supreme_crown', value: 38000, chance: 30, rarity: 'uncommon' },
            { id: 'zephrs_scepter', value: 115000, chance: 12, rarity: 'rare' },
            { id: 'creator_dominus', value: 300000, chance: 3, rarity: 'legendary' }
        ]
    }
];

const flat = [];
for (const c of CASES_DATA_BASE) {
    for (const it of c.items) {
        flat.push({ v: it.value, cid: c.id, sid: it.id });
    }
}
flat.sort((a, b) => {
    if (a.v !== b.v) return a.v - b.v;
    if (a.cid !== b.cid) return a.cid.localeCompare(b.cid);
    return a.sid.localeCompare(b.sid);
});
flat.forEach((row, i) => {
    console.log(i, row.v, row.cid, row.sid);
});
