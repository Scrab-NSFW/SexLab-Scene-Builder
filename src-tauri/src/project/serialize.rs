use serde::{Deserializer, de::{self}};
use std::{collections::HashMap, fmt, vec};

pub fn map_race_to_folder(race: &str) -> Result<String, ()> {
    match race {
        "Human" => Ok("character".into()),
        "Ash Hopper" => Ok("dlc02\\scrib".into()),
        "Bear" => Ok("bear".into()),
        "Boar" | "Boar (Any)" | "Boar (Mounted)" => Ok("dlc02\\boarriekling".into()),
        "Canine" | "Dog" | "Wolf" | "Fox" => Ok("canine".into()),
        "Chaurus" | "Chaurus Reaper" => Ok("chaurus".into()),
        "Chaurus Hunter" => Ok("dlc01\\chaurusflyer".into()),
        "Chicken" => Ok("ambient\\chicken".into()),
        "Cow" => Ok("cow".into()),
        "Deer" => Ok("deer".into()),
        "Dragon Priest" => Ok("dragonpriest".into()),
        "Dragon" => Ok("dragon".into()),
        "Draugr" => Ok("draugr".into()),
        "Dwarven Ballista" => Ok("dlc02\\dwarvenballistacenturion".into()),
        "Dwarven Centurion" => Ok("dwarvensteamcenturion".into()),
        "Dwarven Sphere" => Ok("dwarvenspherecenturion".into()),
        "Dwarven Spider" => Ok("dwarvenspider".into()),
        "Falmer" => Ok("falmer".into()),
        "Flame Atronach" => Ok("atronachflame".into()),
        "Frost Atronach" => Ok("atronachfrost".into()),
        "Storm Atronach" => Ok("atronachstorm".into()),
        "Gargoyle" => Ok("dlc01\\vampirebrute".into()),
        "Giant" => Ok("giant".into()),
        "Goat" => Ok("goat".into()),
        "Hagraven" => Ok("hagraven".into()),
        "Horker" => Ok("horker".into()),
        "Horse" => Ok("horse".into()),
        "Ice Wraith" => Ok("icewraith".into()),
        "Lurker" => Ok("dlc02\\benthiclurker".into()),
        "Mammoth" => Ok("mammoth".into()),
        "Mudcrab" => Ok("mudcrab".into()),
        "Netch" => Ok("dlc02\\netch".into()),
        "Rabbit" => Ok("ambient\\hare".into()),
        "Riekling" => Ok("dlc02\\riekling".into()),
        "Sabrecat" => Ok("sabrecat".into()),
        "Seeker" => Ok("dlc02\\hmdaedra".into()),
        "Skeever" => Ok("skeever".into()),
        "Slaughterfish" => Ok("slaughterfish".into()),
        "Spider" | "Large Spider" | "Giant Spider" => Ok("frostbitespider".into()),
        "Spriggan" => Ok("spriggan".into()),
        "Troll" => Ok("troll".into()),
        "Vampire Lord" => Ok("vampirelord".into()),
        "Werewolf" => Ok("werewolfbeast".into()),
        "Wispmother" => Ok("wisp".into()),
        "Wisp" => Ok("witchlight".into()),
        _ => Err(()),
    }
}

pub struct DeserializeVecOrString;
impl<'de> de::Visitor<'de> for DeserializeVecOrString {
    type Value = Vec<String>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a vector or a string")
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: de::SeqAccess<'de>,
    {
        let mut ret = Vec::new();
        while let Some(data) = seq.next_element()? {
            ret.push(data);
        }
        Ok(ret)
    }

    fn visit_str<E>(self, v: &str) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(vec![v.to_string()])
    }
}
pub fn deserialize_vec_or_string<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: Deserializer<'de>,
{
    deserializer.deserialize_any(DeserializeVecOrString)
}

pub fn make_fnis_lines(
    events: &Vec<String>,
    hash: &str,
    fixed_len: bool,
    anim_obj: &Vec<String>,
) -> Vec<String> {
    if events.len() == 1 {
        return vec![make_fnis_line(
            "b",
            &events[0],
            hash,
            if fixed_len { "a,Tn" } else { "" },
            anim_obj,
        )];
    }
    let mut ret = vec![];
    for (i, event) in events.iter().enumerate() {
        ret.push(make_fnis_line(
            if i == 0 { "s" } else { "+" },
            event,
            hash,
            if fixed_len && i == events.len() - 1 {
                "a,Tn"
            } else {
                ""
            },
            anim_obj,
        ));
    }
    ret
}

fn make_fnis_line(
    anim_type: &str,
    event: &str,
    hash: &str,
    options: &str,
    anim_obj: &Vec<String>,
) -> String {
    format!(
        "{}{} {}{} {}.hkx{}",
        anim_type,
        if options.is_empty() && anim_obj.is_empty() {
            "".into()
        } else if anim_obj.is_empty() {
            format!(" -{}", options)
        } else if options.is_empty() {
            " -o".into()
        } else {
            format!(" -o,{}", options)
        },
        hash,
        event,
        event,
        anim_obj
            .iter()
            .fold(String::from(""), |acc, x| format!("{} {}", acc, x))
    )
}

pub trait EncodeBinary {
    fn get_byte_size(&self) -> usize;
    fn write_byte(&self, buf: &mut Vec<u8>) -> ();
}

impl EncodeBinary for String {
    fn get_byte_size(&self) -> usize {
        size_of::<u64>() + self.len() // u32 for length + string bytes
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        let len = self.len() as u64;
        buf.extend_from_slice(&len.to_be_bytes());
        buf.extend_from_slice(self.as_bytes());
    }
}

impl EncodeBinary for f32 {
    fn get_byte_size(&self) -> usize {
        size_of::<f32>()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
      let scaled_value = (self * 1000.0).round() as i32;
      buf.extend_from_slice(&scaled_value.to_be_bytes());
    }
}

impl EncodeBinary for bool {
    fn get_byte_size(&self) -> usize {
        size_of::<bool>()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        buf.push(*self as u8);
    }
}

impl EncodeBinary for u8 {
    fn get_byte_size(&self) -> usize {
        size_of::<u8>()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        buf.push(*self);
    }
}

impl EncodeBinary for u32 {
    fn get_byte_size(&self) -> usize {
        size_of::<u32>()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        buf.extend_from_slice(&self.to_be_bytes());
    }
}

impl EncodeBinary for u64 {
    fn get_byte_size(&self) -> usize {
        size_of::<u64>()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        buf.extend_from_slice(&self.to_be_bytes());
    }
}

impl<T: EncodeBinary> EncodeBinary for Vec<T> {
    fn get_byte_size(&self) -> usize {
        size_of::<u64>() + self.iter().map(|item| item.get_byte_size()).sum::<usize>()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        let len = self.len() as u64;
        buf.extend_from_slice(&len.to_be_bytes());
        for item in self {
            item.write_byte(buf);
        }
    }
}

impl<K: EncodeBinary, V: EncodeBinary> EncodeBinary for HashMap<K, V> {
    fn get_byte_size(&self) -> usize {
        size_of::<u64>() + 
        self.iter()
            .map(|(key, value)| key.get_byte_size() + value.get_byte_size())
            .sum::<usize>()
    }

    fn write_byte(&self, buf: &mut Vec<u8>) -> () {
        let len = self.len() as u64;
        buf.extend_from_slice(&len.to_be_bytes());
        for (key, value) in self {
            key.write_byte(buf);
            value.write_byte(buf);
        }
    }
}

