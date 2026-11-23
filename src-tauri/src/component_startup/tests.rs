use super::*;
use std::fs;

#[tokio::test]
async fn ready_history_and_data_floor_survive_a_failed_start() {
    let dir = tempfile::tempdir().unwrap();
    let profile = Profile::open(dir.path()).unwrap();
    let manager = Manager::new(profile.clone());
    let channel = component_channel::tests::fixture_channel().await;
    let next = channel.select(None).unwrap().unwrap().combination.clone();
    // The real compatibility fixture's starting version is the previous pair.
    let original = component_channel::tests::initial_combination().await;
    let writer = profile.writer().unwrap();
    manager.begin(&original).unwrap();
    manager.finish(&original, Ok(())).unwrap();
    manager.begin(&original).unwrap();
    manager.finish(&original, Ok(())).unwrap();
    assert_eq!(Journal::read(&profile).unwrap().history.len(), 1);

    let update = PreparedUpdate {
        current: original.identity(),
        current_sequence: original.sequence,
        candidate: next.clone(),
    };
    manager.queue(&update).unwrap();
    assert!(manager.queue(&update).is_err());
    assert_eq!(manager.choose().await.unwrap(), next);
    manager.begin(&next).unwrap();
    assert!(manager
        .finish(&next, Err("test startup failure".into()))
        .is_err());
    drop(writer);

    let migrated = Manager::new(profile.clone());
    let _writer = profile.writer().unwrap();
    assert_eq!(migrated.choose().await.unwrap(), next);
    assert!(check_component_floor(&profile, &original.bamboo.version).is_err());
    migrated.begin(&next).unwrap();
    migrated.finish(&next, Ok(())).unwrap();
    let journal = Journal::read(&profile).unwrap();
    assert!(journal.queued.is_none() && journal.trial.is_none());
    assert_eq!(journal.history.len(), 3);
    assert!(journal.history[1].effective.is_none());
    assert_eq!(
        journal.history[2].effective,
        journal.active.as_ref().map(journal::Versions::from)
    );
    assert!(fs::read_to_string(profile.state_dir.join("state.json"))
        .unwrap()
        .contains(&next.bamboo.version));
}
