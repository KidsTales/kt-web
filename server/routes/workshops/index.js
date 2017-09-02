const express = require('express');
const router = express.Router();
const moment = require('moment');
const request = require('request-promise');
const fs = require('fs');
const path = require('path');
const slack = require('../../modules/slack.js');

router.use(requireVerified);

/* GET home page. */
router.get('/', (req, res, next) => {
    res.locals.pageTitle = 'Workshops';

    req.db.Workshop.find({ endDate: { "$gt": moment().startOf('day').toDate() }})
        .populate('location')
        .populate('ambassador')
        .populate('director')
        .populate('teachers')
        .exec()
        .then(activeWorkshops => {
            res.locals.activeWorkshops = activeWorkshops;

            return res.render('workshops/index');
        })
        .catch(next);
});

/* LIST all workshops (paginated) and allow filtering */
router.get('/list', (req, res, next) => {
    const page = parseInt(req.query.page) || 1;
    if (page < 1) return res.redirect('/workshops/list?page=1');

    req.db.Workshop.paginate({}, { page, limit: 10, populate: ['location', 'ambassador', 'director', 'teachers'], sort: { dateAdded: -1 } })
        .then(result => {
            res.locals.page = result.page;
            res.locals.pages = result.pages;
            res.locals.workshops = result.docs;

            res.render('workshops/list');
        })
        .catch(next);
});

router.get('/new', (req, res, next) => {
    if (req.user.rank == 'teacher' && !req.user.admin) return next(new Error('Teachers cannot add locations.'));

    res.locals.pageTitle = 'Schedule New Workshop';

    req.db.Location.find()
        .exec()
        .then(locations => {
            res.locals.locations = locations;
            res.render('workshops/new');
        })
        .catch(next);
});

router.post('/new', (req, res, next) => {
    if (req.user.rank == 'teacher' && !req.user.admin) return next(new Error('Teachers cannot add locations.'));

    // Location info
    const locationId = req.body.locationId;
    const startDate = moment(req.body.startDate, "YYYY-MM-DD");
    const endDate = moment(req.body.endDate, "YYYY-MM-DD");
    const language = req.body.language;
    const classRoomAvailable = ('classRoomAvailable' in req.body);
    
    // Contact Info
    const contactName = req.body.contactName;
    const contactInfo = req.body.contactInfo;
    
    // Student Info
    const studentCount = req.body.studentCount;
    const studentAgeRange = req.body.ageRange;

    // Teacher Info
    const teacherMin = req.body.teacherMin;
    const preparation = req.body.preparation;

    const extra = req.body.extra;

    // Validate
    if (startDate.isSame(endDate, 'day') || endDate.isBefore(startDate)) return next(new Error('Invalid dates! Make sure the end date comes after the start.'));

    const newWorkshop = new req.db.Workshop({
        location: locationId,
        startDate: startDate.toDate(),
        endDate: endDate.toDate(),
        info: {
            studentCount,
            studentAgeRange,
            teacherMin,
            classRoomAvailable,
            contact: {
                name: contactName,
                contactInfo
            },
            preparation,
            language,
            extra
        },
        dateAdded: new Date()
    });

    newWorkshop.save().then(workshop => {
        req.flash('success', `Scheduled new workshop on ${startDate.format('dddd, MMMM Do YYYY')}.`);
        res.redirect(`/workshops/${workshop._id}`);
    }).catch(next);
});

router.all(['/:workshopId', '/:workshopId/*'], (req, res, next) => {
    req.db.Workshop.findById(req.params.workshopId)
        .populate('location')
        .populate('ambassador')
        .populate('director')
        .populate('teachers')
        .exec()
        .then(workshop => {
            if (!workshop) throw new Error('Failed to find workshop. It may not exist.');
            req.workshop = workshop;

            if (!req.workshop.active) req.flash('warning', 'This workshop is has ended so the following information and fundraising data cannot be edited.');

            return req.db.Funds.find({ workshop: req.workshop._id })
                .limit(10)
                .sort('-dateAdded')
                .populate('submittedBy')
                .exec()
        })
        .then(fundsList => {
            req.recentFunds = fundsList;

            return req.workshop.findApplicants();
        }).then(applicants => {
            req.workshop.applicants = applicants;

            next();
        })
        .catch(next);
});

router.post('/:workshopId/delete', requireAdmin, (req, res, next) => {
    req.workshop.remove()
        .then(workshop => {
            req.flash('success', `Deleted workshop and funds at ${workshop.location.name}.`);
            res.redirect('/workshops');
        })
        .catch(next);
});

const hasRank = (workshop, user) => {
    return workshop.teachers.map(t => t._id).includes(user._id) || (!!workshop.director && workshop.director._id == user.id) || (!!workshop.ambassador && workshop.ambassador._id == user.id);
}

router.get('/:workshopId', (req, res, next) => {
    // CHECK IF NEEDS TO ASSING TO CAMP
    res.locals.recentFunds = req.recentFunds;
    res.locals.apiKey = require('../../config').googleAuth.apiKey;
    res.locals.ofUser = (req.user.admin); // If its the teacher or program director's location

    if (req.query.assign) {
        if (!req.workshop.active) return next(new Error('This workshop in inactive.'));

        const rank = req.query.assign;
        return helpers.assignRank(req.workshop, req.user, rank)
            .then(req.workshop.save)
            .then(workshop => {
                req.flash('success', 'You have become ' + rank + '.');

                // Send emails
                try {
                    if (rank === 'teacher') {
                        sendEmail(req.workshop.director.email, 'New Teacher', `<b><a href='http://localhost:3000/users/${req.user.email}'>${req.user.name.full}</a></b> assigned themselves as a <b>Teacher</b> to <b><a href='http://localhost:3000/workshops/${req.workshop._id}'>Workshop ${req.workshop.location.name}</a></b> which you are the Program Director of.`);
                    } else if (rank === 'director') {
                        sendEmail(req.workshop.ambassador.email, 'New Director', `<b><a href='http://localhost:3000/users/${req.user.email}'>${req.user.name.full}</a></b> assigned themselves as <b>Program Director</b> to <b><a href='http://localhost:3000/workshops/${req.workshop._id}'>Workshop ${req.workshop.location.name}</a></b> which you are the Ambassador of.`);
                    }
                } catch(err) {

                }

                res.redirect('/workshops/' + workshop._id);
            })
            .catch(next);
    } else if (req.query.unassign) {
        // For unassign make sure they are the rank before removing it
        const rank = req.query.unassign;

        if(rank === 'teacher') {
            req.workshop.teachers = req.workshop.teachers.filter(t => t._id != req.user._id);
        } else if (rank == 'director' && req.workshop.director._id == req.user._id) {
            req.workshop.director = undefined;
        } else if (rank == 'ambassador' && req.workshop.ambassador._id == req.user._id) {
            req.workshop.ambassador = undefined;
        } else {
            req.flash('error', 'Invalid rank to unassign!');
        }

        return req.workshop.save()
            .then(workshop => {
                req.flash('success', 'You are no longer ' + rank + '.');

                // Send emails
                try {
                    if (rank === 'teacher') {
                        sendEmail(req.workshop.director.email, 'Teacher Left', `<b><a href='http://localhost:3000/users/${req.user.email}'>${req.user.name.full}</a></b> is no longer a <b>Teacher</b> at <b><a href='http://localhost:3000/workshops/${req.workshop._id}'>Workshop ${req.workshop.location.name}</a></b> which you are the Program Director of.`);
                    } else if (rank === 'director') {
                        sendEmail(req.workshop.ambassador.email, 'Director Left', `<b><a href='http://localhost:3000/users/${req.user.email}'>${req.user.name.full}</a></b> is no longer <b>Program Director</b> of <b><a href='http://localhost:3000/workshops/${req.workshop._id}'>Workshop ${req.workshop.location.name}</a></b> which you are the Ambassador of.`);
                    }
                } catch(err) {

                }

                res.redirect('/workshops/' + workshop._id);
            })
            .catch(next);
    }

    res.locals.workshop = req.workshop;
    res.locals.pageTitle = `Workshop ${req.workshop.location.name}`;
    return res.render('workshops/workshop');
});

router.get('/:workshopId/applicants', (req, res, next) => {
    // Ensure admin, ambassador, or program director
    if (!helpers.isHigherUp(req.workshop, req.user)) {
        req.flash('warning', 'Only admininstrators, ambassadors, and program directors can view applicants.');
        return res.redirect('/workshops/' + req.workshop._id);
    }
    
    res.locals.workshop = req.workshop;
    res.locals.pageTitle = `Workshop ${req.workshop.location.name} Applicants`;
    return res.render('workshops/applicants');
});

router.post('/:workshopId/verify/:email', (req, res, next) => {
    if (!helpers.isHigherUp(req.workshop, req.user)) {
        req.flash('warning', 'Only admininstrators, ambassadors, and program directors can verify applicants.');
        return res.redirect('/workshops/' + req.workshop._id);
    }

    if (!req.workshop.active) {
        req.flash('warning', 'This workshop has already ended. Applications for it are unavailable.');
        return res.redirect('/workshops/' + req.workshop._id);
    }

    req.db.User.findOne({ email: req.params.email })
        .exec()
        .then(applicant => {
            if (!applicant) throw new Error('Applicant does not exist!');
            req.applicant = applicant;

            applicant.verified = true;
            applicant.application.role = ['teacher', 'director'].includes(req.body.role) ? req.body.role : 'teacher';

            return applicant.save()
                .then(helpers.assignRank(req.workshop, applicant, applicant.application.role));
        }).then(applicant => {
            sendEmail(applicant.email, 'Application Accepted', `<h2>Congratulations!</h2><p>Your application to become a Kids Tales <b>${applicant.application.role}</b> for <b>Workshop ${req.workshop.location.name}</b> has been accepted.`);

            try {
                if (applicant.application.role === 'teacher') {
                    sendEmail(req.workshop.director.email, 'New Teacher', `<b><a href='http://localhost:3000/users/${req.user.email}'>${applicant.name.full}</a></b>'s application for <b>Teacher</b> to <b><a href='http://localhost:3000/workshops/${req.workshop._id}'>Workshop ${req.workshop.location.name}</a></b> (which you are the Program Director of) has been accepted.`);
                } else if (applicant.application.role === 'director') {
                    sendEmail(req.workshop.ambassador.email, 'New Director', `<b><a href='http://localhost:3000/users/${req.user.email}'>${applicant.name.full}</a></b>'s application for <b>Program Director</b> to <b><a href='http://localhost:3000/workshops/${req.workshop._id}'>Workshop ${req.workshop.location.name}</a></b> (which you are the Ambassador of) has been accepted.`);
                }
            } catch(err) {}

            req.flash('success', `${req.applicant.name.full} has been verified and assigned as ${req.applicant.application.role}.`)
            res.redirect('/workshops/' + req.workshop._id + '/applicants');

            const p = path.join(__dirname, '..', '..', '..', 'client', 'public', 'writingsamples', applicant.application.writingFileName);

            fs.unlinkSync(p, err => {
                if (err) console.error(err);
            });
        })
        .catch(next);
});

router.get('/:workshopId/edit', requireAdmin, (req, res, next) => {
    res.locals.workshop = req.workshop;

    req.db.Location.find()
        .exec()
        .then(locations => {
            res.locals.openLocations = locations;
            res.locals.pageTitle = `Edit Workshop ${req.workshop.location.name}`;
            res.render('workshops/edit');
        })
        .catch(next);
});

router.post('/:workshopId/edit', requireAdmin, (req, res, next) => {
    req.workshop.location = req.body.locationId;
    req.workshop.startDate = moment(req.body.startDate, "YYYY-MM-DD").toDate();
    req.workshop.endDate = moment(req.body.endDate, "YYYY-MM-DD").toDate();
    //req.workshop.info = req.body.info;

    req.workshop.save()
        .then(workshop => {
            req.flash('success', `Saved edits to workshop.`);
            res.redirect('/workshops/' + workshop._id);
        })
        .catch(next);
});

router.get('/:workshopId/fundraising', (req, res, next) => {
    if (!req.workshop.ready) {
        req.flash('error', 'Once a workshop\'s ranks are filled fundraising will become available.');
        return res.redirect('/workshops/' + req.workshop._id);
    }

    res.locals.workshop = req.workshop;
    res.locals.recentFunds = req.recentFunds;

    req.db.Funds.find({ workshop: req.workshop._id })
        .populate('submittedBy')
        .sort('-dateAdded')
        .exec()
        .then(fundsList => {
            res.locals.funds = fundsList;

            let total = 0;
            fundsList.forEach(f => total += f.amount);
            res.locals.total = total;
                        
            // For charts
            res.locals.fundsTypes = {};
            ['Cash', 'Check', 'Other'].forEach(t => {
                let tTotal = 0;
                fundsList.filter(f => f.form == t).forEach(f => tTotal += f.amount);

                res.locals.fundsTypes[t] = tTotal;
            });

            return req.workshop.findFundraisingGoals();
        }).then(fundraisingGoals => {
            req.workshop.fundraisingGoals = fundraisingGoals;
            res.locals.workshop.fundraisingGoals = fundraisingGoals;

            res.locals.pageTitle = `Workshop ${req.workshop.location.name} Fundraising`;
            res.render('workshops/fundraising/index');
        })
        .catch(next);

});

router.post('/:workshopId/addfunds', (req, res, next) => {
    // Check permissions
    if (!req.user.admin && !helpers.getRankFromWorkshop(req.workshop, req.user)) return next(new Error('You must be an admin and/or involved in the workshop to add this.'));

    const workshopId = req.workshop._id;
    const submittedById = req.user._id;
    const amount = req.body.amount;
    const method = req.body.method;
    const form = req.body.form;
    const source = req.body.source;

    const newFunds = new req.db.Funds({
        workshop: workshopId,
        submittedBy: submittedById,
        amount,
        method,
        form,
        source,
        dateAdded: new Date()
    });

    newFunds.save()
        .then(funds => {
        // Email program director
        const message = `<h3>Teacher ${req.user.name.full} Added Funds to Workshop ${req.workshop.location.name}</h3><p>${req.user.name.first} just added <b>$${amount} in ${form}</b> by <b>${method}</b></p><a href="http://localhost:3000/workshops/${req.workshop._id}/fundraising">View Fundraising</a>`;

        if (req.workshop.ambassador) sendEmail(req.workshop.ambassador.email, "New Funds", message);
        if (req.workshop.director) sendEmail(req.workshop.director.email, "New Funds", message);

        const text = `<http://localhost:3000/users/${req.user.email}|${req.user.name.full}> added **$${amount}** in ${form} to <http://localhost:3000/workshops/${workshopId}|Workshop ${funds.workshop}>`;
        return request({ method: 'POST', uri: require('../../config').slack.webhookUrl, body: { mrkdwn: true, text }, json: true });
    }).then(body => {
        req.flash('success', 'Added new funds for workshop.');
        res.redirect(`/workshops/${req.workshop._id}/fundraising`);
    }).catch(next);
});

router.post('/:workshopId/removefunds', (req, res, next) => {
    req.db.Funds.findById(req.query.fundsId)
        .exec()
        .then(funds => {
            if (!funds) throw new Error('Funds does not exist.');
            if (funds.workshop != req.workshop.id) throw new Error('Those funds are not associated with that workshop!');

            // Check permissions
            if (!req.user.admin) {
                const rank = helpers.getRankFromWorkshop(req.workshop, req.user);
                if (!rank || (rank == 'teacher' && !funds.submittedBy.equals(req.user.id))) throw new Error('You must be an admin, the ambassador, director, or the teacher who added the funds to remove this.');
            }

            return funds.remove();
        })
        .then(funds => {
            req.flash('success', 'Removed funds for workshop.');
            res.redirect('/workshops/' + req.workshop._id + '/fundraising');
        })
        .catch(next);
});

/* FUNDRAISING GOALS */
router.post('/:workshopId/addfundraisinggoal', (req, res, next) => {
    if (!req.user.admin && !helpers.getRankFromWorkshop(req.workshop, req.user)) return next(new Error('You must be an admin and/or involved in the workshop to add this.'));

    const workshopId = req.workshop._id;
    const submittedById = req.user._id;
    const amount = req.body.amount;
    const deadline = moment(req.body.deadline);

    // Validate
    if (deadline.isBefore(moment())) return next(new Error('Deadline must be in the future!'));

    const newFundraisingGoal = new req.db.FundraisingGoal({
        workshop: workshopId,
        submittedBy: submittedById,
        amount,
        deadline,
        dateAdded: new Date()
    });

    newFundraisingGoal.save()
        .then(goal => {
        // Email program director
        const message = `<h3>Teacher ${req.user.name.full} Added Fundraising Goal to Workshop ${req.workshop.location.name}</h3><a href="http://kidstales.ddns.net/workshops/${req.workshop._id}/fundraising">View Fundraising</a>`;

        if (req.workshop.ambassador) sendEmail(req.workshop.ambassador.email, "New Fundraising Goal", message);
        if (req.workshop.director) sendEmail(req.workshop.director.email, "New Fundraising Goal", message);

        const text = `<http://kidstales.ddns.net:3000/users/${req.user.email}|${req.user.name.full}> added **$${amount}** in ${form} to <http://kidstales.ddns.net/workshops/${workshopId}|Workshop ${req.workshop.location.name}>`;
        return slack.sendMessage(text);
    }).then(body => {
        req.flash('success', 'Added new fundraising goal for workshop.');
        res.redirect(`/workshops/${req.workshop._id}/fundraising`);
    }).catch(next);
});

router.post('/:workshopId/removefundraisinggoal', (req, res, next) => {
    req.db.FundraisingGoal.findById(req.query.fundraisingGoalId)
        .exec()
        .then(goal => {
            if (!goal) throw new Error('Fundraising goal does not exist.');
            if (goal.workshop != req.workshop.id) throw new Error('That goal is not associated with that workshop!');

            // Check permissions
            if (!req.user.admin) {
                const rank = helpers.getRankFromWorkshop(req.workshop, req.user);
                if (!rank || (rank == 'teacher' && !goal.submittedBy.equals(req.user.id))) throw new Error('You must be an admin, the ambassador, director, or the teacher who added the goal to remove this.');
            }

            return goal.remove();
        })
        .then(funds => {
            req.flash('success', 'Removed fundraising goal for workshop.');
            res.redirect('/workshops/' + req.workshop._id + '/fundraising');
        })
        .catch(next);
});

module.exports = router;
